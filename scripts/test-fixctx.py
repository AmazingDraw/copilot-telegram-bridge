#!/usr/bin/env python3

import json
import os
import sqlite3
import stat
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "fix-model-tokens.sh"
MODELS_PATH = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / "config" / "models.json"


def expected_specs(config):
    catalog = config["catalog"]
    model_ids = config["modelSets"]["fixctx"]["models"]
    expected_db = {}
    expected_ocx = {}
    ensure_enabled = []
    for model_id in model_ids:
        spec = catalog[model_id]
        fixctx = spec["fixctx"]
        expected_db[model_id] = (
            fixctx.get("copilotPromptTokens", spec["maxPromptTokens"]),
            fixctx.get("copilotOutputTokens", spec["maxOutputTokens"]),
        )
        expected_ocx[model_id] = fixctx["opencodexContextWindow"]
        if fixctx.get("ensureEnabled") is True:
            ensure_enabled.append(f"cliproxy/{model_id}")
    return model_ids, expected_db, expected_ocx, ensure_enabled


def create_database(path, model_ids):
    connection = sqlite3.connect(path)
    connection.execute(
        """
        CREATE TABLE provider_models (
            model_id TEXT PRIMARY KEY,
            max_prompt_tokens INTEGER,
            max_output_tokens INTEGER,
            updated_at TEXT
        )
        """
    )
    connection.executemany(
        "INSERT INTO provider_models VALUES (?, 1, 1, NULL)",
        [(model_id,) for model_id in model_ids],
    )
    connection.commit()
    connection.close()


def run_fixctx(db, opencodex, *, check, models_path=MODELS_PATH):
    env = os.environ.copy()
    env.update(
        {
            "FIXCTX_MODELS_CONFIG": str(models_path),
            "FIXCTX_COPILOT_DB": str(db),
            "FIXCTX_OPENCODEX_CONFIG": str(opencodex),
            "FIXCTX_SKIP_OPENCODEX_RESTART": "1",
        }
    )
    return subprocess.run(
        ["bash", str(SCRIPT)],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=check,
    )


config = json.loads(MODELS_PATH.read_text())
model_ids, expected_db, expected_ocx, ensure_enabled = expected_specs(config)
if len(model_ids) < 2:
    raise SystemExit("fixture requires at least two fixctx models")

with tempfile.TemporaryDirectory(prefix="bridge-fixctx-") as temp:
    temp = Path(temp)
    db = temp / "data.db"
    create_database(db, model_ids)

    opencodex = temp / "config.json"
    keep_disabled = "cliproxy/fixture-keep-disabled"
    opencodex.write_text(
        json.dumps(
            {
                "providers": {"cliproxy": {"modelContextWindows": {}}},
                "disabledModels": [*ensure_enabled, keep_disabled],
            }
        )
    )
    os.chmod(opencodex, 0o600)

    result = run_fixctx(db, opencodex, check=True)

    connection = sqlite3.connect(db)
    actual_db = {
        model_id: (prompt, output)
        for model_id, prompt, output in connection.execute(
            "SELECT model_id, max_prompt_tokens, max_output_tokens FROM provider_models"
        )
    }
    connection.close()
    assert actual_db == expected_db

    updated = json.loads(opencodex.read_text())
    assert updated["providers"]["cliproxy"]["modelContextWindows"] == expected_ocx
    assert updated["disabledModels"] == [keep_disabled]
    assert stat.S_IMODE(opencodex.stat().st_mode) == 0o600
    assert f"校验 {len(model_ids)} 个上下文" in result.stdout

    rollback_db = temp / "rollback.db"
    create_database(rollback_db, model_ids)
    connection = sqlite3.connect(rollback_db)
    trigger_model = model_ids[1].replace("'", "''")
    connection.execute(
        f"""
        CREATE TRIGGER fail_fixture_update
        BEFORE UPDATE ON provider_models
        WHEN NEW.model_id = '{trigger_model}'
        BEGIN
            SELECT RAISE(ABORT, 'fixture rollback');
        END
        """
    )
    connection.commit()
    connection.close()

    failed = run_fixctx(rollback_db, temp / "missing-opencodex.json", check=False)
    assert failed.returncode != 0
    connection = sqlite3.connect(rollback_db)
    rollback_values = list(
        connection.execute(
            "SELECT DISTINCT max_prompt_tokens, max_output_tokens FROM provider_models"
        )
    )
    connection.close()
    assert rollback_values == [(1, 1)], "SQLite transaction did not roll back fully"

    invalid_config = json.loads(MODELS_PATH.read_text())
    invalid_config["modelSets"]["fixctx"]["models"] = model_ids[:2]
    del invalid_config["catalog"][model_ids[1]]
    invalid_path = temp / "invalid-models.json"
    invalid_path.write_text(json.dumps(invalid_config))
    parser_db = temp / "parser.db"
    create_database(parser_db, model_ids[:2])
    parser_ocx = temp / "parser-opencodex.json"
    parser_ocx.write_text(json.dumps({"providers": {"cliproxy": {"modelContextWindows": {}}}}))

    parser_failed = run_fixctx(
        parser_db,
        parser_ocx,
        check=False,
        models_path=invalid_path,
    )
    assert parser_failed.returncode != 0
    connection = sqlite3.connect(parser_db)
    parser_values = list(
        connection.execute(
            "SELECT DISTINCT max_prompt_tokens, max_output_tokens FROM provider_models"
        )
    )
    connection.close()
    assert parser_values == [(1, 1)], "partial catalog parse modified SQLite"
    assert json.loads(parser_ocx.read_text())["providers"]["cliproxy"]["modelContextWindows"] == {}

print(
    f"fixctx fixtures OK: db={len(expected_db)} windows={len(expected_ocx)} "
    "atomic-json=ok rollback=ok parse-guard=ok"
)

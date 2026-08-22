#!/usr/bin/env python3

import json
import os
import sqlite3
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
    for model_id in model_ids:
        spec = catalog[model_id]
        fixctx = spec.get("fixctx") or {}
        expected_db[model_id] = (
            fixctx.get("copilotPromptTokens", spec["maxPromptTokens"]),
            fixctx.get("copilotOutputTokens", spec["maxOutputTokens"]),
        )
    return model_ids, expected_db


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


def run_fixctx(db, *, check, models_path=MODELS_PATH):
    env = os.environ.copy()
    env.update(
        {
            "FIXCTX_MODELS_CONFIG": str(models_path),
            "FIXCTX_COPILOT_DB": str(db),
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
model_ids, expected_db = expected_specs(config)
if len(model_ids) < 2:
    raise SystemExit("fixture requires at least two fixctx models")

with tempfile.TemporaryDirectory(prefix="bridge-fixctx-") as temp:
    temp = Path(temp)
    db = temp / "data.db"
    create_database(db, model_ids)

    result = run_fixctx(db, check=True)

    connection = sqlite3.connect(db)
    actual_db = {
        model_id: (prompt, output)
        for model_id, prompt, output in connection.execute(
            "SELECT model_id, max_prompt_tokens, max_output_tokens FROM provider_models"
        )
    }
    connection.close()
    assert actual_db == expected_db
    assert f"更新 {len(model_ids)} 个" in result.stdout

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

    failed = run_fixctx(rollback_db, check=False)
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

    parser_failed = run_fixctx(
        parser_db,
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

print(
    f"fixctx fixtures OK: db={len(expected_db)} "
    "rollback=ok parse-guard=ok"
)

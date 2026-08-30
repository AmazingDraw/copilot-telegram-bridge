// telegram-bridge/lib/markdown-tg.mjs — Markdown → Telegram HTML & chunking

export const CHUNK_MAX = 4096;

export function chunkMessage(text, maxLen = CHUNK_MAX) {
    const chunks = [];
    let remaining = text;
    while (remaining.length > maxLen) {
        let splitAt = remaining.lastIndexOf("\n\n", maxLen);
        if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", maxLen);
        if (splitAt <= 0) splitAt = maxLen;
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).replace(/^\n+/, "");
    }
    if (remaining.length > 0) chunks.push(remaining);
    return chunks;
}

/**
 * 模型有时用 HTML `<br>` 做换行；sendMessage HTML 不认该标签，需映射为 `\n`。
 * 但下列区域不得把 br 换成换行（否则结构被撕）：
 *   • 围栏代码 / 双反引号 code / 单反引号 code（讲解字面量）
 *   • Markdown 表格整块（单元格内裸 br→\n 会拆掉 | 行，rich 抽表失败）
 * 先 hold 上述区域，再替换裸标签。rich 事后生成的 <br> 不经此函数。
 */
export function normalizeModelHtmlBreaks(md) {
    if (!md) return md;
    const holds = [];
    const hold = (s) => {
        const i = holds.length;
        holds.push(s);
        return makeHoldToken("M", i);
    };
    // 围栏代码块（含可选 \ 前缀反引号，与现有解析器对齐）
    let t = md.replace(/(?:\\*`){3,}[^\n]*\n[\s\S]*?(?:\\*`){3,}/g, (m) => hold(m));
    // Markdown 表格整块（与 extractTables 同形），禁止单元格内 br→\n
    t = t.replace(
        /^(?:>\s*)*(\|.+\|[ \t]*)\n(?:>\s*)*(\|[-| :]+\|[ \t]*)\n((?:(?:>\s*)*\|.+\|[ \t]*\n?)+)/gm,
        (m) => hold(m)
    );
    // 双反引号 code span（CommonMark：内容可含单 `，不跨行）
    t = t.replace(/``(?:[^`\n]|`(?!`))*``/g, (m) => hold(m));
    // 单反引号行内 code（不跨行）
    t = t.replace(/`[^`\n]+`/g, (m) => hold(m));
    // 内联 Markdown 结构（加粗/斜体/链接）：保护区内 <br> 不得拆行（否则 ** 跨行裸显）
    // 先 hold 再替换 <br>：区内 <br> → 空格，区外裸 <br> → \n
    t = t.replace(/\*\*[^*\n]+\*\*/g, (m) => hold(m.replace(/<br\s*\/?>/gi, " ")));
    t = t.replace(/(?<!\*)\*[^*\n]+\*(?!\*)/g, (m) => hold(m.replace(/<br\s*\/?>/gi, " ")));
    t = t.replace(/\[[^\]\n]+\]\([^)\n]+\)/g, (m) => hold(m.replace(/<br\s*\/?>/gi, " ")));
    t = t.replace(/<br\s*\/?>/gi, "\n");
    t = restoreHoldTokens(t, "M", holds);
    return t;
}

/**
 * Telegram 不支持 <details> 折叠。伪折叠处理：
 *   <details><summary>标题</summary>内容</details> → ▶ 标题\n内容
 * 若无可读 summary，则直接剥标签留内容。
 */
export function normalizeDetailsFold(md) {
    if (!md || !/<\/?details\b/i.test(md)) return md;
    return String(md)
        .replace(/<details\b[^>]*>/gi, "\n")
        .replace(/<\/details\s*>/gi, "\n")
        .replace(/<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/gi, (_, s) => {
            const t = String(s).replace(/<br\s*\/?>/gi, " ").replace(/<\/?[^>]+>/g, "").trim();
            return t ? `▶ ${t}\n` : "";
        });
}

/**
 * 模型偶发输出 TG 不支持的 HTML 定义列表 `<dl>/<dt>/<dd>`。
 * 在进 rich/safe 前整块收成 Markdown 列表，走现有 `•` / `<p>` 管线，
 * 避免事后在 HTML 里塞 `\n` 被 sendRichMessage 折叠。
 * 围栏 / 表 / 行内 code 内字面量不动（hold 顺序与 br 一致）。
 */
export function normalizeModelDefinitionLists(md) {
    if (!md || !/<\/?d[ltd]\b/i.test(md)) return md;

    const holds = [];
    const hold = (s) => {
        const i = holds.length;
        holds.push(s);
        return makeHoldToken("M", i);
    };

    let t = md.replace(/(?:\\*`){3,}[^\n]*\n[\s\S]*?(?:\\*`){3,}/g, (m) => hold(m));
    t = t.replace(
        /^(?:>\s*)*(\|.+\|[ \t]*)\n(?:>\s*)*(\|[-| :]+\|[ \t]*)\n((?:(?:>\s*)*\|.+\|[ \t]*\n?)+)/gm,
        (m) => hold(m)
    );
    t = t.replace(/``(?:[^`\n]|`(?!`))*``/g, (m) => hold(m));
    t = t.replace(/`[^`\n]+`/g, (m) => hold(m));

    const flattenInner = (html) => {
        let s = String(html ?? "");
        s = s.replace(/<br\s*\/?>/gi, " ");
        s = s.replace(/<\/?[^>]+>/g, "");
        return s.replace(/\s+/g, " ").trim();
    };

    const convertDlInner = (inner) => {
        const lines = [];
        let currentDt = null;
        const dds = [];
        const flush = () => {
            if (currentDt == null && dds.length === 0) return;
            const term = currentDt != null ? flattenInner(currentDt) : "";
            const def = dds.map(flattenInner).filter(Boolean).join("; ");
            if (term && def) lines.push(`• **${term}**: ${def}`);
            else if (term) lines.push(`• **${term}**`);
            else if (def) lines.push(`• ${def}`);
            currentDt = null;
            dds.length = 0;
        };

        const re = /<dt\b[^>]*>([\s\S]*?)<\/dt\s*>|<dd\b[^>]*>([\s\S]*?)<\/dd\s*>/gi;
        let m;
        while ((m = re.exec(inner)) !== null) {
            if (m[1] !== undefined) {
                flush();
                currentDt = m[1];
            } else {
                dds.push(m[2] ?? "");
            }
        }
        flush();

        if (lines.length === 0) {
            const plain = flattenInner(inner);
            return plain ? `\n\n${plain}\n\n` : "\n\n";
        }
        return `\n\n${lines.join("\n")}\n\n`;
    };

    // 整块 <dl>…</dl>
    t = t.replace(/<dl\b[^>]*>([\s\S]*?)<\/dl\s*>/gi, (_, inner) => convertDlInner(inner));
    // 无 <dl> 包裹的连续 dt + 一个或多个 dd（仅独占行触发，避免行内/标题误伤）
    t = t.replace(
        /(^|\n)\s*<dt\b[^>]*>([\s\S]*?)<\/dt\s*>(?:\s*<dd\b[^>]*>([\s\S]*?)<\/dd\s*>)+/gi,
        (full, lead, term) => {
            const dds = [];
            const reDd = /<dd\b[^>]*>([\s\S]*?)<\/dd\s*>/gi;
            let m;
            while ((m = reDd.exec(full)) !== null) dds.push(m[1]);
            const t0 = flattenInner(term);
            const d0 = dds.map(flattenInner).filter(Boolean).join("; ");
            if (t0 && d0) return `${lead}• **${t0}**: ${d0}`;
            if (t0) return `${lead}• **${t0}**`;
            if (d0) return `${lead}• ${d0}`;
            return lead;
        }
    );
    // 残留孤儿 dt/dd（仅独占行触发）
    t = t.replace(/(^|\n)\s*<dt\b[^>]*>([\s\S]*?)<\/dt\s*>/gi, (full, lead, c) => {
        const term = flattenInner(c);
        return term ? `${lead}• **${term}**` : lead;
    });
    t = t.replace(/(^|\n)\s*<dd\b[^>]*>([\s\S]*?)<\/dd\s*>/gi, (full, lead, c) => {
        const def = flattenInner(c);
        return def ? `${lead}• ${def}` : lead;
    });
    t = t.replace(/<\/?dl\b[^>]*>/gi, "");
    t = t.replace(/<\/?d[td]\b[^>]*>/gi, "");

    t = restoreHoldTokens(t, "M", holds);
    return t;
}

// --- Markdown to Telegram HTML converter ---

export function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}


/** 占位符起止（Unicode 私有区，Telegram 不可见；勿用 \x01/\x06+digit，剥离后会显示成孤零零的 "0"） */
const HOLD_MARK = "\uE000";
const HOLD_END = "\uE001";

function makeHoldToken(kind, index) {
    return `${HOLD_MARK}${kind}${index}:${HOLD_END}`;
}

function restoreHoldTokens(text, kind, holds) {
    const re = new RegExp(`${HOLD_MARK}${kind}(\\d+):${HOLD_END}`, "g");
    return text.replace(re, (_, idx) => holds[Number(idx)] ?? "");
}

/** 发送前兜底：清掉旧版/泄漏的控制符占位，避免 Telegram 把索引 0 渲成可点链接 */
export function scrubTelegramHtml(html) {
    if (!html) return "";
    return html
        .replace(/\x01\d+\x01/g, "")
        .replace(/\x02\d+\x02/g, "")
        .replace(/\x05\d+\x05/g, "")
        .replace(/\x06\d+\x06/g, "")
        .replace(/\x00\d+\x00/g, "")
        .replace(new RegExp(`${HOLD_MARK}[A-Z]\\d+:${HOLD_END}`, "g"), "")
        .replace(/[\x00-\x06]/g, "");
}

function scrubLeakedHoldMarkers(html) {
    return scrubTelegramHtml(html);
}

// ============================================================
// Section 4a: 表格 Markdown 解析器与 HTML/列表 渲染器
// ============================================================

/**
 * 解析 Markdown 格式的表格行
 * @param {string} headerRow 表格表头行 (例如 "| 标题1 | 标题2 |")
 * @param {string} bodyRows 表格数据行 (换行分隔的多行数据)
 * @returns {{headers: string[], rows: string[][]}} 解析后的表头与每行单元格数组
 */
export function parseMarkdownTable(headerRow, bodyRows) {
    const parseRow = (row) => {
        // 步骤 0: 剥离行首引用标记（例如 "> ", ">>" 等），支持嵌套在引用块内的表格
        let cleanRow = row.replace(/^(?:>\s*)+/, "");
        // 步骤 1: 保护转义的竖线 \|，避免被误切分
        let safe = cleanRow.replace(/\\\|/g, "\x04PIPE");
        // 步骤 2: 保护剧透语法 ||text|| 占位，防止其中的竖线被误切分
        let spoilIdx = 0;
        const spoilMap = {};
        safe = safe.replace(/\|\|([^|]+)\|\|/g, (_, content) => {
            const ph = `\x04S${spoilIdx}\x04`;
            spoilMap[ph] = `||${content}||`;
            spoilIdx++;
            return ph;
        });
        // 步骤 3: 按竖线 | 分割；兼容有/无外侧 | 的行
        let cells = safe.split("|");
        const trimmed = safe.trim();
        if (trimmed.startsWith("|")) cells = cells.slice(1);
        if (trimmed.endsWith("|")) cells = cells.slice(0, -1);
        cells = cells.map((c) => {
            let val = c.trim();
            for (const [ph, original] of Object.entries(spoilMap)) {
                val = val.replaceAll(ph, original);
            }
            val = val.replaceAll("\x04PIPE", "|");
            return val;
        });
        return cells;
    };
    const headers = parseRow(headerRow);
    const rows = bodyRows.trim().split("\n").map(parseRow);
    return { headers, rows };
}

/** 单元格内模型常用的 HTML/实体换行。抽表前不能先换成 \\n，否则会拆掉 | 行。 */
const CELL_BR_RE = /(?:<\s*br\s*\/?\s*>|&lt;\s*br\s*\/?\s*&gt;)/gi;

export function splitHtmlBreaks(text) {
    const raw = String(text ?? "");
    if (!raw) return [""];
    const parts = raw.split(CELL_BR_RE).map((p) => p.trim());
    const nonempty = parts.filter(Boolean);
    return nonempty.length ? nonempty : [""];
}

function escapeInlineCellHtml(text) {
    return splitHtmlBreaks(text).map((p) => escapeInline(p)).join("<br>");
}

function formatTableCellForList(text, indent = "      ") {
    const parts = splitHtmlBreaks(text);
    if (parts.length <= 1) return escapeInline(parts[0] || "—");
    return `\n${parts.map((p) => `${indent}${escapeInline(p)}`).join("\n")}`;
}

function listField(prefix, headerHtml, cellRaw) {
    const v = formatTableCellForList(cellRaw);
    return v.startsWith("\n")
        ? `${prefix} <b>${headerHtml}</b>:${v}`
        : `${prefix} <b>${headerHtml}</b>: ${v}`;
}

/**
 * 将解析后的表格转换为原生 HTML <table> 结构 (仅用于 sendRichMessage 接口)
 * @param {{headers: string[], rows: string[][]}} table 表头及每行单元格
 * @returns {string} HTML <table> 字符串
 */
export function tableToHtmlTable({ headers, rows }) {
    const headerCells = headers.map(h => `<td><b>${escapeInlineCellHtml(h)}</b></td>`).join("");
    const bodyRows = rows.map(row => {
        const cells = row.map(c => `<td>${escapeInlineCellHtml(c || "—")}</td>`).join("");
        return `<tr>${cells}</tr>`;
    }).join("");
    return `<table><tr>${headerCells}</tr>${bodyRows}</table>`;
}

/**
 * 将解析后的表格转换为结构化卡片式的 HTML 列表 (用于不支持 table 时的安全降级退化显示)
 * @param {{headers: string[], rows: string[][]}} table 表头及每行单元格
 * @returns {string} 列表样式的文本
 */
export function tableToList({ headers, rows }) {
    if (!headers || headers.length === 0 || !rows || rows.length === 0) return "";

    return rows.map((row) => {
        if (!row || row.length === 0) return "";
        
        const firstHeader = escapeInline(headers[0] || "项目");

        // 单列/简单列表
        if (headers.length === 1) {
            return listField("•", firstHeader, row[0] || "—");
        }

        // 两列键值对卡片
        if (headers.length === 2) {
            const title = escapeInline(splitHtmlBreaks(row[0] || "—").join(" / ") || "—");
            const secondHeader = escapeInline(headers[1] || "内容");
            return `📌 <b>${title}</b> (${firstHeader})\n${listField("   └ 🔹", secondHeader, row[1] || "—")}`;
        }

        // 3列或多列对比卡片 (如: 字段 | 优化前 | 优化后)
        const subItems = [];
        for (let i = 1; i < headers.length; i++) {
            const h = escapeInline(headers[i] || `列${i+1}`);
            const isLast = (i === headers.length - 1);
            const prefix = isLast ? "   └ 🔸" : "   ├ 🔹";
            subItems.push(listField(prefix, h, row[i] || "—"));
        }

        return listField("📌", firstHeader, row[0] || "—") + `\n${subItems.join("\n")}`;
    }).filter(Boolean).join("\n\n");
}

/**
 * 将「松散」Markdown 表格规范成两侧带 `|` 的标准形。
 * 模型常输出：
 *   方案 | 做法 | 优缺点
 *   :-- | :-- | :--
 *   A | B | C |
 * 现有 extractTables 只认以 `|` 开头且以 `|` 结尾的行，导致同一消息里
 * 标准表能渲染、松散表变成原文。围栏代码块内字面量不动。
 * @param {string} md
 * @returns {string}
 */
export function normalizeLooseMarkdownTables(md) {
    if (!md || !md.includes("|")) return md;

    const holds = [];
    const hold = (s) => {
        const i = holds.length;
        holds.push(s);
        return makeHoldToken("M", i);
    };
    let t = md.replace(/(?:\\*`){3,}[^\n]*\n[\s\S]*?(?:\\*`){3,}/g, (m) => hold(m));

    const splitQuote = (line) => {
        const m = String(line).match(/^((?:>\s*)*)(.*)$/);
        return { quote: m ? m[1] : "", rest: m ? m[2] : String(line) };
    };

    const isSepRest = (rest) => {
        let t0 = rest.trim();
        if (!t0) return false;
        // 必须像分隔行：含 |，或整行只是 :--- 之类（极少见，要求至少有 -）
        if (!t0.includes("|") && !/^:?-{3,}:?$/.test(t0)) return false;
        if (t0.startsWith("|")) t0 = t0.slice(1);
        if (t0.endsWith("|")) t0 = t0.slice(0, -1);
        const cells = t0.split("|").map((c) => c.trim());
        if (cells.length < 1) return false;
        // 允许 :-- / --- / :---: 等；拒绝对话里偶发的 "a | b"
        return cells.every((c) => /^:?-{1,}:?$/.test(c));
    };

    const isRowRest = (rest) => {
        const t0 = rest.trim();
        if (!t0 || !t0.includes("|")) return false;
        if (isSepRest(rest)) return false;
        return true;
    };

    const ensureOuterPipes = (rest) => {
        let s = rest.trim();
        if (!s) return rest;
        if (!s.startsWith("|")) s = `| ${s}`;
        if (!s.endsWith("|")) s = `${s} |`;
        return s;
    };

    const lines = t.split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const { quote: q0, rest: r0 } = splitQuote(lines[i]);
        const { quote: q1, rest: r1 } = splitQuote(lines[i + 1] ?? "");
        if (
            i + 1 < lines.length &&
            isRowRest(r0) &&
            isSepRest(r1) &&
            // 表头至少两列更稳（单列松散极少，且易误伤）
            (r0.match(/\|/g) || []).length >= 1
        ) {
            const block = [
                q0 + ensureOuterPipes(r0),
                q1 + ensureOuterPipes(r1),
            ];
            let j = i + 2;
            while (j < lines.length) {
                const { quote: qj, rest: rj } = splitQuote(lines[j]);
                if (!rj.trim()) break;
                if (!isRowRest(rj)) break;
                block.push(qj + ensureOuterPipes(rj));
                j++;
            }
            // header+sep 即可；有正文更好。无正文也规范化，避免半截表
            out.push(...block);
            i = j;
            continue;
        }
        out.push(lines[i]);
        i++;
    }

    t = out.join("\n");
    t = restoreHoldTokens(t, "M", holds);
    return t;
}

/**
 * 检查文本中是否包含 Markdown 表格 (支持带有引用前缀 (如 >) 以及行尾空格的表格)
 * 先规范化松散表，再检测标准 `|...|` 形。
 * @param {string} md Markdown 文本
 * @returns {boolean} 是否含表格
 */
export function hasTable(md) {
    const n = normalizeLooseMarkdownTables(md);
    return /^(?:>\s*)*\|.+\|[ \t]*$/m.test(n) && /^(?:>\s*)*\|[-| :]+\|[ \t]*$/m.test(n);
}

/**
 * 从 Markdown 文本中提取出表格，并将文本切分成“非表格文本段落”与“表格数据”
 * @param {string} md Markdown 原始文本
 * @returns {{parts: string[], tables: object[]}} 切分后的普通文本数组及对应的表格数组
 */
export function extractTables(md) {
    md = normalizeLooseMarkdownTables(md);
    // 升级版：支持带可选前置引用标记 (如 >) 且行尾带多余空格的表格全局提取
    const tableRegex = /^(?:>\s*)*(\|.+\|[ \t]*)\n(?:>\s*)*(\|[-| :]+\|[ \t]*)\n((?:(?:>\s*)*\|.+\|[ \t]*\n?)+)/gm;
    const parts = [];
    const tables = [];
    let lastIndex = 0;
    let match;
    while ((match = tableRegex.exec(md)) !== null) {
        parts.push(md.slice(lastIndex, match.index));
        tables.push(parseMarkdownTable(match[1], match[3]));
        lastIndex = match.index + match[0].length;
    }
    parts.push(md.slice(lastIndex));
    return { parts, tables };
}

/**
 * 清除并转换 Telegram 不支持的已转义 HTML 标签 (如 &lt;dl&gt; 系列)，防范 Telegram 400 实体错误并还原真 b 标签。
 * 必须先 hold <pre>/<code>，否则 &lt;dt&gt;…&lt;/dt&gt; 会跨 code 边界误匹配，撕坏字面量与围栏。
 * 主路径已用 normalizeModelDefinitionLists 收裸标签；此处仅兜底残留。
 * @param {string} html 编译后的 HTML 文本
 * @returns {string} 过滤还原后的富 HTML 文本
 */
function cleanUnsupportedHtmlTagsAfterEscape(html) {
    if (!html) return "";
    const holds = [];
    const hold = (s) => {
        const i = holds.length;
        holds.push(s);
        return makeHoldToken("H", i);
    };
    // pre 优先（可含 code）；再 hold 行内 code
    let t = html.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, (m) => hold(m));
    t = t.replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, (m) => hold(m));

    t = t.replace(/&lt;dt\b[^&]*&gt;([\s\S]*?)&lt;\/dt\s*&gt;/gi, "• <b>$1</b>:");
    t = t.replace(/&lt;dd\b[^&]*&gt;([\s\S]*?)&lt;\/dd\s*&gt;[ \t]*/gi, " $1\n\n");
    t = t.replace(/&lt;\/?dl\b[^&]*&gt;/gi, "");
    // 折叠「换行+空白+换行」，不碰 hold 占位
    t = t.replace(/\n\s*\n/g, "\n\n");

    t = restoreHoldTokens(t, "H", holds);
    // 自动剥去 Telegram API 不支持的超链接内嵌套 <code> 标签 (如 <a href="..."><code>text</code></a> → <a href="...">text</a>)，
    // 避免 Telegram 忽略 <a> 标签将其降级为无法点击的纯 <code>
    t = t.replace(/<a\s+href="([^"]+)"><code>([\s\S]*?)<\/code><\/a>/gi, '<a href="$1">$2</a>');
    return scrubLeakedHoldMarkers(t);
}

// ============================================================
// Section 4b: 段落内联 Markdown 格式解析为 HTML 标签
// ============================================================

/**
 * 解码模型在正文（非代码块）中可能输出的 HTML 实体。
 * 常见场景：模型输出 `• &lt; 9:`、`&gt;`、`&le;` 等，若不先解码，
 * 紧随其后的 escapeHtml 会将 `&` 转为 `&amp;` 导致 Telegram 渲染为字面量 `&lt;`。
 * 注意：必须先解码专用实体，最后解码 &amp;，且必须在代码/链接保护之后执行。
 */
export function unescapeCommonEntities(s) {
    if (!s || !s.includes("&")) return s;
    return s
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, "\"")
        .replace(/&apos;/gi, "'")
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/gi, " ")
        .replace(/&le;/gi, "≤")
        .replace(/&ge;/gi, "≥")
        .replace(/&ne;/gi, "≠")
        .replace(/&times;/gi, "×")
        .replace(/&divide;/gi, "÷")
        .replace(/&plusmn;/gi, "±")
        .replace(/&mdash;/gi, "—")
        .replace(/&ndash;/gi, "–")
        .replace(/&hellip;/gi, "…")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&amp;/gi, "&");
}

/**
 * 转换段落内的行内样式 (加粗、斜体、删除线、超链接、行内代码、自动链接等)
 * @param {string} text 传入的单行纯文本
 * @returns {string} 转换后的 HTML 段落文本
 */
export function escapeInline(text) {
    // 1. 保护行内代码：先双反引号（内容可含单 `），再单反引号；不跨行
    const codeHolds = [];
    const holdCode = (code) => {
        const i = codeHolds.length;
        // CommonMark：若内容首尾各有一空格，剥一层（`` `x` `` → `x`）
        let c = code;
        if (c.length >= 2 && c.startsWith(" ") && c.endsWith(" ")) {
            c = c.slice(1, -1);
        }
        codeHolds.push(`<code>${escapeHtml(c)}</code>`);
        return makeHoldToken("C", i);
    };
    let t = text.replace(/``((?:[^`\n]|`(?!`))*)``/g, (_, code) => holdCode(code));
    t = t.replace(/`([^`\n]+)`/g, (_, code) => holdCode(code));

    // 2. 保护 Markdown 链接 [text](url)，防止其内部字符被解析
    const linkHolds = [];
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
        const i = linkHolds.length;
        linkHolds.push(`<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`);
        return makeHoldToken("L", i);
    });

    // 2.5 在非代码/非链接的正文中，先解码模型输出的 HTML 实体，防止进入 escapeHtml 后产生 &amp;lt; 双重转义
    t = unescapeCommonEntities(t);

    // 3. 将其余所有的 HTML 特殊字符进行安全转义 (防止破坏标签结构)
    t = escapeHtml(t);

    // 4. 解析加粗并倾斜 ***text***
    t = t.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");
    // 5. 解析加粗 **bold**
    t = t.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    // 6. 解析倾斜 *italic*
    t = t.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
    // 7. 解析下划线 __underline__
    t = t.replace(/__(.+?)__/g, "<u>$1</u>");
    // 8. 解析删除线 ~~strikethrough~~
    t = t.replace(/~~(.+?)~~/g, "<s>$1</s>");
    // 8b. 解析下标 ~x~（Telegram 无 <sub>，用 <u> 近似；避免与 ~~ 删除线冲突）
    //     仅匹配 字母/数字 的短下标，如 H~2~O；多字符也可，但排除含空格的
    t = t.replace(/(?<!~)~([A-Za-z0-9]{1,3})~(?!~)/g, "<u>$1</u>");
    // 9. 解析剧透模糊 ||spoiler||
    t = t.replace(/\|\|(.+?)\|\|/g, "<tg-spoiler>$1</tg-spoiler>");

    // 10. 自动识别并转换纯 URL 文本为可点击超链接 (排除属性引用等)
    t = t.replace(/(?<!["'=\/<])(https?:\/\/[^\s<>]+)/g, (url) => {
        // 清理末尾可能误吞的中文标点符号
        let cleaned = url.replace(/[\u3000-\u9fff\uff00-\uffef.,;:!?\u3001\u3002]+$/, "");
        if (!cleaned) return url;
        return `<a href="${cleaned}">${cleaned}</a>`;
    });

    // 11. 还原前面保护的行内代码和链接占位符
    // 注意：必须【先还原 linkHolds】，将链接内可能嵌套的 code hold 展开放回字符串中，【再还原 codeHolds】
    t = restoreHoldTokens(t, "L", linkHolds);
    t = restoreHoldTokens(t, "C", codeHolds);

    return scrubLeakedHoldMarkers(t);
}

// ============================================================
// Section 4c: 全文本 Markdown 转富 HTML (专用于 sendRichMessage)
// ============================================================

/**
 * 将整篇 Markdown 解析并拼接成含有表格 <table> 标签的富 HTML 字符串
 * @param {string} md Markdown 原文
 * @returns {{html: string, hasTables: boolean}} 渲染后的 HTML 字符串及是否包含表格的标志
 */
export function markdownToRichHtml(md) {
    const { parts, tables } = extractTables(md);
    const hasTables = tables.length > 0;

    let html = "";
    for (let pi = 0; pi < parts.length; pi++) {
        html += richConvertTextPart(parts[pi]);
        if (pi < tables.length) html += tableToHtmlTable(tables[pi]);
    }
    return { html, hasTables };
}

/**
 * 转换非表格普通段落为 HTML 结构 (支持列表、标题、引用块等)
 * @param {string} text 文本段落
 * @returns {string} 渲染后的 HTML
 */
export function richConvertTextPart(text) {
    if (!text.trim()) return "";

    const holds = [];
    function hold(html) {
        const i = holds.length;
        holds.push(html);
        return makeHoldToken("B", i);
    }

    let t = text;

    // 提取并保护围栏代码块，支持零个或多个前置转义斜杠及三个或多个反引号，代码块内不进行任何 markdown 解析
    t = t.replace(/(?:\\*`){3,}(\w*)\n([\s\S]*?)(?:\\*`){3,}/g, (_, lang, code) => {
        code = code.replace(/\n$/, "");
        if (lang) {
            return hold(`<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre>`);
        }
        return hold(`<pre><code>${escapeHtml(code)}</code></pre>`);
    });

    const lines = t.split("\n");
    const outputLines = [];
    let inList = null; // "ul" 或 "ol"
    let listItems = [];
    // sendRichMessage 折叠裸 \n：普通正文必须进块级 <p>，段内多行用 <br>
    let paraLines = [];

    function flushList() {
        if (inList && listItems.length > 0) {
            const tag = inList;
            outputLines.push(`<${tag}>${listItems.join("")}</${tag}>`);
            listItems = [];
            inList = null;
        }
    }

    function flushPara() {
        if (paraLines.length === 0) return;
        outputLines.push(`<p>${paraLines.join("<br>")}</p>`);
        paraLines = [];
    }

    function flushBlocks() {
        flushList();
        flushPara();
    }

    let i = 0;
    while (i < lines.length) {
        let line = lines[i];

        // 占位符行 (代码块等)，直接输出，需要先关闭之前的列表/段落
        if (line.includes(HOLD_MARK)) {
            flushBlocks();
            outputLines.push(line);
            i++;
            continue;
        }

        // 标题行: # 标题 -> <h1> 等 HTML 标签
        const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headerMatch) {
            flushBlocks();
            const level = headerMatch[1].length;
            const content = escapeInline(headerMatch[2]);
            outputLines.push(`<h${level}>${content}</h${level}>`);
            i++;
            continue;
        }

        // 引用块: > 引用内容 (合并连续的引用行)
        if (/^>\s?/.test(line)) {
            flushBlocks();
            const quoteLines = [];
            while (i < lines.length && /^>\s?/.test(lines[i])) {
                quoteLines.push(lines[i].replace(/^>\s?/, ""));
                i++;
            }
            const content = richConvertTextPart(quoteLines.join("\n"));
            outputLines.push(`<blockquote>${content}</blockquote>`);
            continue;
        }

        // 无序列表: - / *，以及模型常直接输出的 • / ·
        const ulMatch = line.match(/^(\s*)(?:[-*]|[•·])\s+(.+)$/);
        if (ulMatch) {
            flushPara();
            if (inList !== "ul") flushList();
            inList = "ul";
            listItems.push(`<li>${escapeInline(ulMatch[2])}</li>`);
            i++;
            continue;
        }

        // 有序列表: 数字. 开头
        const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
        if (olMatch) {
            flushPara();
            if (inList !== "ol") flushList();
            inList = "ol";
            listItems.push(`<li>${escapeInline(olMatch[2])}</li>`);
            i++;
            continue;
        }

        // 水平分割线 (支持 Markdown 的 ---, ***, ___ 以及直接输出的 ───)
        if (/^[-*_─]{3,}\s*$/.test(line.trim())) {
            flushBlocks();
            outputLines.push("<p>────────────</p>");
            i++;
            continue;
        }

        // 空行：结束当前段落/列表（块级标签自身提供间距，不输出裸空行）
        if (!line.trim()) {
            flushBlocks();
            i++;
            continue;
        }

        // 普通段落行：合并连续行进 <p>，避免 sendRichMessage 把 \n 折叠成空格
        flushList();
        paraLines.push(escapeInline(line));
        i++;
    }
    flushBlocks();

    // 拼接并还原代码块等占位符
    let result = outputLines.join("\n").replace(/\n{3,}/g, "\n\n");
    result = restoreHoldTokens(result, "B", holds);
    return cleanUnsupportedHtmlTagsAfterEscape(result);
}

/**
 * 封装给 sendRichMessage 使用的最终 HTML 构建器
 */
export function buildRichMessageHtml(md) {
    const { html } = markdownToRichHtml(md);
    return scrubTelegramHtml(html);
}

// ============================================================
// Section 4d: 安全 HTML/降级列表构建器 (用于 sendMessage 消息兼容)
// ============================================================

/**
 * 降级生成器：将表格转为 plain-text 列表，其余文本用标准的 Telegram HTML 转义
 * @param {string} md Markdown 原始文本
 * @returns {string|null} 转义后的 HTML。如果不含表格，返回 null
 */
export function buildListFallbackHtml(md, opts) {
    const { parts, tables } = extractTables(md);
    if (tables.length === 0) return null;

    let html = "";
    for (let i = 0; i < parts.length; i++) {
        if (parts[i]) html += markdownToTelegramHtmlSafe(parts[i], opts);
        if (i < tables.length) html += tableToList(tables[i]) + "\n";
    }
    return scrubTelegramHtml(html);
}

/**
 * 整篇 Markdown 转为 Telegram 标准 sendMessage 支持的安全 HTML (清除 table/details/标题/列表标签)
 * @param {string} md Markdown 原文
 * @returns {string} 转换后的安全 HTML
 */
export function markdownToTelegramHtmlSafe(md, opts = {}) {
    if (!md.trim()) return "";
    const planStyle = !!opts?.planStyle;
    md = normalizeDetailsFold(md);
    const lines = md.split("\n");
    const output = [];
    let i = 0;

    while (i < lines.length) {
        let line = lines[i];
        const trimmedLine = line.trim();

        // 升级版围栏代码块正则：支持可选斜杠前缀的反引号组连续出现 3 次及以上
        const codeBlockMatch = trimmedLine.match(/^(?:\\*`){3,}(\w*)/);
        if (codeBlockMatch) {
            const lang = codeBlockMatch[1] || "";
            let code = "";
            i++;
            // 闭合判定也升级为相同的正则
            while (i < lines.length && !/^(?:\\*`){3,}\s*$/.test(lines[i].trim())) {
                code += lines[i] + "\n";
                i++;
            }
            i++; // 跳过结束的 ```
            code = code.replace(/\n$/, "");
            if (lang) {
                output.push(`<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre>`);
            } else {
                output.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
            }
            continue;
        }

        // 标题行 -> 编译为加粗文本；Plan 样式下标题后补空行与正文分隔
        const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (hMatch) {
            output.push(`<b>${escapeInline(hMatch[2])}</b>`);
            if (planStyle) output.push("");
            i++;
            continue;
        }

        // 整行加粗短标题（Plan 专用）：整行 **xxx** → 加粗标题并前后补空行
        const boldLineMatch = planStyle ? /^\*\*(.+?)\*\*\s*$/.exec(line) : null;
        if (boldLineMatch) {
            if (output.length > 0 && output[output.length - 1] !== "") output.push("");
            output.push(`<b>${escapeInline(boldLineMatch[1])}</b>`);
            output.push("");
            i++;
            continue;
        }

        // 引用块 -> <blockquote>
        if (/^>\s?/.test(line)) {
            const quoteLines = [];
            while (i < lines.length && /^>\s?/.test(lines[i])) {
                quoteLines.push(lines[i].replace(/^>\s?/, ""));
                i++;
            }
            const content = markdownToTelegramHtmlSafe(quoteLines.join("\n"), opts);
            output.push(`<blockquote>${content}</blockquote>`);
            continue;
        }

        // 无序列表 -> 降级为纯文本点 •（-/* 全模式；• 前缀仅在 planStyle 下识别，避免影响普通消息）
        const ulMatch = line.match(planStyle ? /^(\s*)(?:[-*]|•)\s+(.+)$/ : /^(\s*)[-*]\s+(.+)$/);
        if (ulMatch) {
            const indent = ulMatch[1] ? "  " : "";
            // Plan 样式：连续列表项间加空行呼吸（对齐 cursor bridge）
            if (planStyle && output.length > 0 && /^\s*(?:•|\d+\.)\s+\S/.test(output[output.length - 1])) {
                output.push("");
            }
            output.push(`${indent}• ${escapeInline(ulMatch[2])}`);
            i++;
            continue;
        }

        // 有序列表 -> 降级为纯文本数字.
        const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
        if (olMatch) {
            const indent = olMatch[1] ? "  " : "";
            // Plan 样式：每个编号项前加空行呼吸（对齐 cursor bridge）
            if (planStyle && output.length > 0 && output[output.length - 1] !== "") {
                output.push("");
            }
            output.push(`${indent}${olMatch[2]}. ${escapeInline(olMatch[3])}`);
            i++;
            continue;
        }

        // 分割线 -> 降级为横线字符，并进行间距归一化（确保上下各有且仅有一个空行，解决 Telegram 客户端列表间距折叠渲染 Bug）
        if (/^[-*_─]{3,}\s*$/.test(line.trim())) {
            // 确保上方有且仅有一个空行
            if (output.length > 0 && output[output.length - 1] !== "") {
                output.push("");
            }
            output.push("──────────");
            // 确保下方有且仅有一个空行
            if (i + 1 < lines.length) {
                if (!lines[i + 1].trim()) {
                    output.push("");
                    i++; // 跳过下一个天然空行，防止重复产生空行
                } else {
                    output.push("");
                }
            }
            i++;
            continue;
        }

        // 空行
        if (!line.trim()) {
            output.push("");
            i++;
            continue;
        }

        // 普通行，进行行内样式解析
        if (planStyle) {
            // Plan 样式：段落与后续列表之间加空行呼吸（"说明文字 → • 效果" 场景）
            let nextNonEmpty = "";
            for (let j = i + 1; j < lines.length; j++) {
                if (lines[j].trim()) { nextNonEmpty = lines[j].trim(); break; }
            }
            if (nextNonEmpty && /^(?:[-*]|•|\d+\.)\s+/.test(nextNonEmpty)) {
                output.push(escapeInline(line));
                output.push("");
                i++;
                continue;
            }
        }
        output.push(escapeInline(line));
        i++;
    }

    const compiled = output.join("\n").replace(/\n{3,}/g, "\n\n");
    return cleanUnsupportedHtmlTagsAfterEscape(compiled);
}

// v1.0.1 sync test

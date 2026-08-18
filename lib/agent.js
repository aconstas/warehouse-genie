const ollama = require("./ollama");
const databricks = require("./databricks");
const { selectTables, selectExamples } = require("./retrieval");

/* ---------------------------------------------------------- prompt builder */

function renderTable(t) {
  const cols = t.columns
    .map((c) => `  ${c.name} ${c.type}${c.comment ? ` -- ${c.comment}` : ""}`)
    .join("\n");
  const synonyms = t.synonyms?.length ? `\n(also known as: ${t.synonyms.join(", ")})` : "";
  return `TABLE ${t.full_name}${t.description ? `\n${t.description}` : ""}${synonyms}\n${cols}`;
}

function buildSystemPrompt(pack, question) {
  const tables = selectTables(pack, question);
  const examples = selectExamples(pack, question);

  const sections = [
    "You are a senior analytics engineer writing Databricks SQL (Spark SQL dialect) against Unity Catalog tables.",
  ];

  if (pack.instructions?.trim()) {
    sections.push(`## Workspace instructions\n${pack.instructions.trim()}`);
  }

  sections.push(`## Available tables\n${tables.map(renderTable).join("\n\n")}`);

  if (pack.relationships?.length) {
    sections.push(`## Relationships and join hints\n${pack.relationships.map((r) => `- ${r.description}`).join("\n")}`);
  }

  if (examples.length) {
    sections.push(
      `## Example queries\n` +
      examples.map((ex) =>
        `Q: ${ex.question}\n\`\`\`sql\n${ex.sql.trim()}\n\`\`\`${ex.notes ? `\nNote: ${ex.notes}` : ""}`
      ).join("\n\n")
    );
  }

  sections.push([
    "## Rules",
    "- Use ONLY the tables and columns listed above. Never invent a table or column.",
    "- Always use fully qualified names (catalog.schema.table).",
    "- Prefer explicit column lists over SELECT *.",
    "- Add LIMIT 1000 to non-aggregate queries.",
    "- The app renders charts from your result set. If the user asks for a chart, graph, plot, or a trend/over-time/by-period view, just return the SQL for the underlying data (ordered sensibly, e.g. by the time column) — never reply that you cannot make visualizations.",
    "- If the question cannot be answered with these tables, or is ambiguous, reply in plain text (no SQL) explaining what you need.",
    "- Otherwise respond with exactly one ```sql fenced code block and nothing else."
  ].join("\n"));

  return { prompt: sections.join("\n\n"), tablesUsed: tables.map((t) => t.full_name), examplesUsed: examples.length };
}

function extractSql(text) {
  const fence = text.match(/```sql\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  // Model sometimes answers with bare SQL — accept it if it looks like a statement
  if (/^\s*(select|with|show|describe)\b/i.test(text)) return text.trim();
  return null;
}

// Statement-type keywords that must never appear as a standalone word anywhere
// in an executed statement. A `WITH` CTE can legally precede an
// INSERT/UPDATE/DELETE/MERGE on Databricks, so a first-token check alone is not
// enough — we scan the whole (comment/string-stripped) statement.
// Deliberately excludes words that double as common column names or scalar
// functions (comment, set, replace, use, get, put, copy, refresh, …) to avoid
// falsely blocking legitimate read queries; the ones below cannot appear in a
// well-formed SELECT/CTE except as the head of a mutation/DDL/DCL statement.
const MUTATION_KEYWORDS = new Set([
  "insert", "update", "delete", "merge", "upsert",
  "create", "drop", "alter", "truncate", "grant", "revoke"
]);

const ALLOWED_FIRST_TOKENS = new Set(["select", "with", "show", "describe", "desc", "explain"]);

/** Remove line comments, block comments, and string/backtick literals so a
 *  mutation keyword can't hide inside them and evade the read-only check. */
function stripSqlNoise(sql) {
  return String(sql)
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, " ")
    .replace(/"(?:[^"]|"")*"/g, " ")
    .replace(/`(?:[^`]|``)*`/g, " ");
}

/**
 * Only allow read statements through — this app is for asking questions, not
 * mutating data. Defends against the CTE-prefixed mutation bypass by checking
 * both that the first keyword is an allowed read verb AND that no mutation
 * keyword appears anywhere in the statement body.
 */
function isReadOnly(sql) {
  const cleaned = stripSqlNoise(sql).trim();
  if (!cleaned) return false;

  const first = cleaned.split(/\s+/)[0]?.toLowerCase();
  if (!ALLOWED_FIRST_TOKENS.has(first)) return false;

  for (const word of cleaned.toLowerCase().match(/[a-z_]+/g) || []) {
    if (MUTATION_KEYWORDS.has(word)) return false;
  }
  return true;
}

/* ------------------------------------------------------------- agent loop */

/**
 * Run one turn. history = [{question, sql}] from earlier turns in this conversation.
 * Returns { kind: "sql"|"text", attempts, result?, summary?, text?, meta }
 *
 * Optional onEvent(event) is called as the turn progresses so callers can stream
 * the experience live. Event shapes:
 *   { type: "phase",         phase, attempt }   status transitions
 *   { type: "gen_token",     text }             model tokens while writing SQL/clarification
 *   { type: "sql",           sql, attempt }     the finalized SQL about to run
 *   { type: "attempt",       attempt }          an attempt's outcome ({sql,status,error?})
 *   { type: "result",        result }           the successful result set
 *   { type: "summary_token", text }             model tokens while summarizing
 *   { type: "text",          text }             a plain-text (non-SQL) answer
 * The final return value is unchanged, so non-streaming callers work as before.
 */
async function runTurn({ cfg, pack, question, history, onEvent }) {
  const emit = typeof onEvent === "function" ? onEvent : () => {};
  const { prompt: systemPrompt, tablesUsed, examplesUsed } = buildSystemPrompt(pack, question);
  const meta = { tablesUsed, examplesUsed };

  const messages = [{ role: "system", content: systemPrompt }];
  for (const turn of history.slice(-4)) {
    messages.push({ role: "user", content: turn.question });
    messages.push({ role: "assistant", content: "```sql\n" + turn.sql + "\n```" });
  }
  messages.push({ role: "user", content: question });

  const attempts = [];
  const maxRetries = cfg.maxRetries ?? 2;

  // Roll up Ollama's per-call timing across every LLM call in this turn
  // (generate + retries + summarize) so callers can report inference speed.
  const startedAt = Date.now();
  const raw = { model: cfg.ollamaModel, llmCalls: 0, promptTokens: 0, genTokens: 0, genNs: 0, totalNs: 0, loadNs: 0 };
  const onStats = (s) => {
    raw.llmCalls += 1;
    raw.promptTokens += s.prompt_eval_count || 0;
    raw.genTokens += s.eval_count || 0;
    raw.genNs += s.eval_duration || 0;
    raw.totalNs += s.total_duration || 0;
    raw.loadNs += s.load_duration || 0;
    if (s.model) raw.model = s.model;
  };
  const withStats = (turn) => ({
    ...turn,
    stats: {
      model: raw.model,
      llmCalls: raw.llmCalls,
      promptTokens: raw.promptTokens,
      genTokens: raw.genTokens,
      genSeconds: +(raw.genNs / 1e9).toFixed(2),
      totalModelSeconds: +(raw.totalNs / 1e9).toFixed(2),
      loadSeconds: +(raw.loadNs / 1e9).toFixed(2),
      wallSeconds: +((Date.now() - startedAt) / 1000).toFixed(2),
      genTokPerSec: raw.genNs ? +(raw.genTokens / (raw.genNs / 1e9)).toFixed(1) : null
    }
  });

  const generate = (attempt) => {
    emit({ type: "phase", phase: "generating", attempt });
    return ollama.chatStream(cfg, messages, { onStats }, (t) => emit({ type: "gen_token", text: t }));
  };

  let response = await generate(0);
  let sql = extractSql(response);

  if (!sql) {
    // Model chose to clarify instead of generating SQL
    emit({ type: "text", text: response });
    return withStats({ kind: "text", text: response, attempts, meta });
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (!isReadOnly(sql)) {
      const blocked = { sql, status: "blocked", error: "Non read-only statement" };
      emit({ type: "attempt", attempt: blocked });
      return withStats({
        kind: "text",
        text: "The generated statement wasn't a read-only query, so it was blocked. This app only runs SELECT-style statements.",
        attempts: [...attempts, blocked],
        meta
      });
    }

    emit({ type: "phase", phase: "executing", attempt });
    emit({ type: "sql", sql, attempt });
    const result = await databricks.executeStatement(cfg, sql);

    if (result.ok) {
      const done = { sql, status: "succeeded" };
      attempts.push(done);
      emit({ type: "attempt", attempt: done });
      emit({ type: "result", result });
      emit({ type: "phase", phase: "summarizing", attempt });
      const summary = await summarize(cfg, question, result, emit, onStats).catch(() => null);
      return withStats({ kind: "sql", attempts, result, summary, meta });
    }

    const failed = { sql, status: "failed", error: result.error };
    attempts.push(failed);
    emit({ type: "attempt", attempt: failed });
    if (attempt === maxRetries) {
      return withStats({ kind: "sql", attempts, result: null, summary: null, meta });
    }

    // Self-heal: feed the Databricks error back and ask for a fix
    messages.push({ role: "assistant", content: "```sql\n" + sql + "\n```" });
    messages.push({
      role: "user",
      content: `That query failed with this Databricks error:\n\n${result.error}\n\nFix the SQL. Respond with exactly one \`\`\`sql block.`
    });
    response = await generate(attempt + 1);
    const fixed = extractSql(response);
    if (!fixed) {
      emit({ type: "text", text: response });
      return { kind: "text", text: response, attempts, meta };
    }
    sql = fixed;
  }
}

async function summarize(cfg, question, result, emit = () => {}, onStats = null) {
  const sample = result.rows.slice(0, 15);
  const content = [
    `Question: ${question}`,
    `Columns: ${result.columns.map((c) => c.name).join(", ")}`,
    `First rows (JSON): ${JSON.stringify(sample)}`,
    `Total rows returned: ${result.rowCount}${result.truncated ? " (truncated)" : ""}`,
    "",
    "Answer the question in 1-2 plain sentences using only this data. No preamble, no markdown."
  ].join("\n");
  const text = await ollama.chatStream(cfg, [{ role: "user", content }], { temperature: 0.2, onStats },
    (t) => emit({ type: "summary_token", text: t }));
  return text.trim().slice(0, 600);
}

module.exports = { runTurn, buildSystemPrompt, isReadOnly, extractSql };

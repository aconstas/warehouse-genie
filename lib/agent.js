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

/** Only allow read statements through — this app is for asking questions, not mutating data. */
function isReadOnly(sql) {
  const first = sql.trim().split(/\s+/)[0]?.toLowerCase();
  return ["select", "with", "show", "describe", "desc", "explain"].includes(first);
}

/* ------------------------------------------------------------- agent loop */

/**
 * Run one turn. history = [{question, sql}] from earlier turns in this conversation.
 * Returns { kind: "sql"|"text", attempts, result?, summary?, text?, meta }
 */
async function runTurn({ cfg, pack, question, history }) {
  const { prompt: systemPrompt, tablesUsed, examplesUsed } = buildSystemPrompt(pack, question);

  const messages = [{ role: "system", content: systemPrompt }];
  for (const turn of history.slice(-4)) {
    messages.push({ role: "user", content: turn.question });
    messages.push({ role: "assistant", content: "```sql\n" + turn.sql + "\n```" });
  }
  messages.push({ role: "user", content: question });

  const attempts = [];
  const maxRetries = cfg.maxRetries ?? 2;

  let response = await ollama.chat(cfg, messages);
  let sql = extractSql(response);

  if (!sql) {
    // Model chose to clarify instead of generating SQL
    return { kind: "text", text: response, attempts, meta: { tablesUsed, examplesUsed } };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (!isReadOnly(sql)) {
      return {
        kind: "text",
        text: "The generated statement wasn't a read-only query, so it was blocked. This app only runs SELECT-style statements.",
        attempts: [...attempts, { sql, status: "blocked", error: "Non read-only statement" }],
        meta: { tablesUsed, examplesUsed }
      };
    }

    const result = await databricks.executeStatement(cfg, sql);

    if (result.ok) {
      attempts.push({ sql, status: "succeeded" });
      const summary = await summarize(cfg, question, result).catch(() => null);
      return { kind: "sql", attempts, result, summary, meta: { tablesUsed, examplesUsed } };
    }

    attempts.push({ sql, status: "failed", error: result.error });
    if (attempt === maxRetries) {
      return { kind: "sql", attempts, result: null, summary: null, meta: { tablesUsed, examplesUsed } };
    }

    // Self-heal: feed the Databricks error back and ask for a fix
    messages.push({ role: "assistant", content: "```sql\n" + sql + "\n```" });
    messages.push({
      role: "user",
      content: `That query failed with this Databricks error:\n\n${result.error}\n\nFix the SQL. Respond with exactly one \`\`\`sql block.`
    });
    response = await ollama.chat(cfg, messages);
    const fixed = extractSql(response);
    if (!fixed) {
      return { kind: "text", text: response, attempts, meta: { tablesUsed, examplesUsed } };
    }
    sql = fixed;
  }
}

async function summarize(cfg, question, result) {
  const sample = result.rows.slice(0, 15);
  const content = [
    `Question: ${question}`,
    `Columns: ${result.columns.map((c) => c.name).join(", ")}`,
    `First rows (JSON): ${JSON.stringify(sample)}`,
    `Total rows returned: ${result.rowCount}${result.truncated ? " (truncated)" : ""}`,
    "",
    "Answer the question in 1-2 plain sentences using only this data. No preamble, no markdown."
  ].join("\n");
  const text = await ollama.chat(cfg, [{ role: "user", content }], { temperature: 0.2 });
  return text.trim().slice(0, 600);
}

module.exports = { runTurn, buildSystemPrompt };

const express = require("express");
const path = require("path");
const crypto = require("crypto");

const config = require("./lib/config");
const contextPack = require("./lib/contextPack");
const databricks = require("./lib/databricks");
const ollama = require("./lib/ollama");
const agent = require("./lib/agent");

const PORT = process.env.PORT || 4177;
const app = express();

// Anti-DNS-rebinding: this server holds the Databricks PAT and has no auth, so
// it must only ever answer requests addressed to loopback. A malicious page
// that rebinds a hostname to 127.0.0.1 would otherwise reach the API
// same-origin and could repoint databricksHost to exfiltrate the token. Reject
// any Host that isn't localhost/127.0.0.1 (optionally with our port).
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${PORT}`, `localhost:${PORT}`,
  "127.0.0.1", "localhost"
]);
app.use((req, res, next) => {
  const host = (req.headers.host || "").toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    return res.status(403).json({ error: "Forbidden host" });
  }
  next();
});

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// In-memory conversation state: id -> [{question, sql}]. Capped so a long-lived
// process can't grow it without bound; oldest conversations are evicted first.
const conversations = new Map();
const MAX_CONVERSATIONS = 200;

function rememberConversation(convId, history) {
  conversations.delete(convId);          // re-insert so this id becomes newest (LRU-ish)
  conversations.set(convId, history);
  while (conversations.size > MAX_CONVERSATIONS) {
    conversations.delete(conversations.keys().next().value); // drop oldest
  }
}

/* -------------------------------------------------------------------- chat */

app.post("/api/chat", async (req, res) => {
  const { message, conversationId } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: "Empty message" });

  const convId = conversationId || crypto.randomUUID();
  const history = conversations.get(convId) || [];
  const cfg = config.load();
  const pack = contextPack.load();

  if (!pack.tables.length) {
    return res.json({
      conversationId: convId,
      kind: "text",
      text: "The context pack has no tables yet. Open Context Pack and sync a schema from Databricks (or add tables manually) so I know what data exists."
    });
  }

  try {
    const turn = await agent.runTurn({ cfg, pack, question: message.trim(), history });

    // Remember successful turns so follow-ups ("now break that out by month") work
    const lastGoodSql = turn.attempts?.findLast?.((a) => a.status === "succeeded")?.sql;
    if (lastGoodSql) {
      history.push({ question: message.trim(), sql: lastGoodSql });
      rememberConversation(convId, history.slice(-8));
    }

    res.json({ conversationId: convId, ...turn });
  } catch (e) {
    res.status(500).json({ conversationId: convId, error: e.message });
  }
});

app.post("/api/chat/reset", (req, res) => {
  const { conversationId } = req.body || {};
  if (conversationId) conversations.delete(conversationId);
  res.json({ ok: true });
});

/* -------------------------------------------------------------- context pack */

app.get("/api/pack", (_req, res) => res.json(contextPack.load()));

app.put("/api/pack", (req, res) => {
  try {
    res.json(contextPack.save(req.body));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/pack/export", (_req, res) => {
  const pack = contextPack.load();
  res.setHeader("Content-Disposition", `attachment; filename="context-pack-v${pack.version}.json"`);
  res.json(pack);
});

app.post("/api/pack/sync-tables", async (req, res) => {
  const { catalog, schema, tables } = req.body || {};
  if (!catalog || !schema) return res.status(400).json({ error: "catalog and schema are required" });
  try {
    const cfg = config.load();
    const synced = await databricks.fetchSchemaMetadata(cfg, catalog, schema, tables);
    if (!synced.length) {
      return res.status(404).json({ error: `No tables found in ${catalog}.${schema}. Check the names and your permissions.` });
    }
    const merged = contextPack.mergeSyncedTables(contextPack.load(), synced);
    res.json({ pack: contextPack.save(merged), syncedCount: synced.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------- settings + health */

app.get("/api/settings", (_req, res) => res.json(config.publicView(config.load())));

const SETTINGS_KEYS = [
  "databricksHost", "databricksToken", "warehouseId",
  "ollamaUrl", "ollamaModel", "maxRetries", "rowLimit"
];

app.put("/api/settings", (req, res) => {
  const body = req.body || {};
  // Whitelist known keys only — never let the client write arbitrary config.
  const patch = {};
  for (const key of SETTINGS_KEYS) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  // Coerce the numeric settings and reject junk rather than persisting a string.
  for (const key of ["maxRetries", "rowLimit"]) {
    if (patch[key] !== undefined) {
      const n = Number(patch[key]);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: `${key} must be a non-negative number` });
      patch[key] = Math.floor(n);
    }
  }
  // Don't overwrite the stored token with the masked value round-tripped from the UI
  if (!patch.databricksToken || patch.databricksToken.startsWith("••••")) delete patch.databricksToken;
  res.json(config.publicView(config.save(patch)));
});

app.get("/api/health", async (_req, res) => {
  const cfg = config.load();
  const [db, llm] = await Promise.all([databricks.health(cfg), ollama.health(cfg)]);
  res.json({ databricks: db, ollama: llm });
});

/* Preview the exact prompt the agent would build for a question (data team debugging aid) */
app.post("/api/prompt-preview", (req, res) => {
  const { question } = req.body || {};
  const built = agent.buildSystemPrompt(contextPack.load(), question || "");
  res.json(built);
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  genie-local running → http://127.0.0.1:${PORT}\n`);
});

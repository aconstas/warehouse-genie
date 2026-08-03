# CLAUDE.md — Warehouse Genie (local)

## What this is

A self-hosted, Genie-style NL→SQL agent for Databricks. A local LLM (Ollama) writes Spark SQL grounded in a curated **context pack** (our equivalent of a Databricks Genie space), executes it via the Databricks SQL Statement Execution API with the user's own permissions, self-heals on SQL errors, and shows every attempt in the UI.

Origin: replicating Databricks Genie without per-token LLM costs and with a
"nothing leaves the machine except calls to our own workspace" privacy story.
Endgame is an internal desktop app for INNOCEAN stakeholders (data team curates
the context pack; stakeholders ask questions).

## Architecture

```
server.js          Express, binds 127.0.0.1:4177 only
public/            vanilla JS SPA — chat + context pack editor (no build step, on purpose)
lib/agent.js       the loop: retrieve → prompt → generate → execute → retry(≤2) → summarize
lib/retrieval.js   lexical keyword ranking of tables + examples per question
lib/databricks.js  SQL Statement Execution API (30s wait + polling) + information_schema sync
lib/ollama.js      chat completions; strips qwen3 <think> blocks
lib/contextPack.js versioned JSON store (context-pack.json) — the "Genie space"
lib/config.js      config.json settings; env vars override
```

Key behaviors:
- Read-only guard: only SELECT/WITH/SHOW/DESCRIBE/EXPLAIN are executed.
- Failed Databricks errors are fed back to the model for a fix (max 2 retries);
  every attempt is shown in the UI statement trail.
- Follow-ups replay prior (question, successful SQL) turns as chat history
  (in-memory Map, last 8 turns).
- Metadata sync queries information_schema via SQL — NOT the UC REST API.
  This is why a PAT scoped to only `sql` is sufficient.
- Pack merge rules: human table descriptions/synonyms survive re-sync;
  fresh UC column comments win over stale local ones.

## Decisions already made (don't relitigate without reason)

- **Vanilla JS frontend, no framework/build step** — ports to Electron by loading
  the same static bundle against the localhost server.
- **Lexical retrieval for MVP** — lib/retrieval.js is deliberately isolated so it
  can be swapped for embeddings (nomic-embed-text via Ollama + sqlite-vec)
  without touching the agent.
- **PAT auth for prototype** — scoped to `sql` API scope only. Packaged app must
  move to Databricks U2M OAuth + Electron safeStorage.
- **Context pack ships separately from app code** — packs are versioned JSON,
  exported/imported today; later fetched by version from S3/CloudFront so the
  data team can update the "space" without an app release.
- **Vanna (archived Mar 2026) and WrenAI (pivoted to agent/CLI context layer)
  were evaluated and rejected** in favor of building; Vanna's DDL/docs/examples
  training taxonomy inspired the pack structure.
- Default model qwen3:14b; num_ctx 8192; temperature 0.1 for SQL generation.

## Roadmap (rough priority order)

1. Embeddings retrieval (nomic-embed-text + sqlite-vec) behind the same
   selectTables/selectExamples interface.
2. Streaming responses (Ollama supports it; stream into the statement card).
3. "Save as example" feedback loop — a 👍 on a good answer offers to add the
   (question, SQL) pair into the pack. This is how the pack compounds.
4. Simple bar/line chart toggle over result tables.
5. Electron packaging: spawn server.js from main process, config/pack paths →
   app.getPath("userData"), U2M OAuth, electron-updater against a CloudFront
   manifest, model runtime as a bundled llama.cpp sidecar (not a system
   Ollama install).

## Conventions

- Node 18+, CommonJS, Express only — keep the dependency count near zero.
- All frontend/server communication is relative-path fetch to localhost.
- Never log or echo the PAT; config.json is gitignored territory (it holds the
  token in plaintext for now).
- Escape all user/model content before injecting into DOM (esc() in app.js).
- Known fixed bug to not reintroduce: `.modal-backdrop` needs the
  `[hidden] { display: none; }` override because its `display:flex` beats the
  UA hidden rule.

## Testing quickly

`npm start` → http://127.0.0.1:4177. Health endpoint: GET /api/health.
Prompt construction can be tested without Ollama/Databricks via
POST /api/prompt-preview {"question": "..."} — also exposed in the UI's
Context pack → preview tab.

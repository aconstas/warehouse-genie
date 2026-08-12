# Warehouse Genie (local)
<img width="1276" height="810" alt="image" src="https://github.com/user-attachments/assets/11e90dc9-ee11-47bc-b913-67b687734c34" />

A self-hosted, Genie-style NL→SQL agent for Databricks. A local model (via Ollama) writes Spark SQL grounded in a curated **context pack** — your team's equivalent of a Genie space — executes it through the Databricks SQL Statement Execution API with the user's own permissions, self-heals on errors, and shows every attempt it took.

Nothing leaves the machine except calls to your own Databricks workspace.

## Prerequisites

- Node.js 18+
- [Ollama](https://ollama.com) running locally with a model pulled, e.g. `ollama pull qwen3:14b`
- A Databricks workspace URL, a personal access token, and a SQL warehouse ID
  (warehouse ID is the last segment of the warehouse's URL, or Compute → SQL warehouses → your warehouse → Connection details)

## Run it

```bash
npm install
npm start          # → http://127.0.0.1:4177
```

First launch:

1. **Settings** (bottom of sidebar) → add workspace URL, PAT, warehouse ID, Ollama model. Both health pills should go green.
2. **Context pack → tables** → sync a catalog.schema. This pulls tables, columns, types, and comments from `information_schema`.
3. Write **descriptions and synonyms** for each table, add **instructions** (metric definitions, fiscal calendar, default filters), and add a few **example** question→SQL pairs.
4. **Ask** something.

A demo context pack (`context-pack.json`) ships with the repo so you can see what good curation looks like — replace it with your own via sync, or Import a pack JSON someone shared with you.

## Architecture

```
public/           vanilla JS SPA (chat + context pack editor)
server.js         Express, binds 127.0.0.1 only
lib/agent.js      the loop: build prompt → generate → execute → retry on error → summarize
lib/retrieval.js  lexical ranking of tables + examples per question (upgrade path: embeddings)
lib/databricks.js SQL Statement Execution API + information_schema metadata sync
lib/ollama.js     local chat completions (strips qwen3 <think> blocks)
lib/contextPack.js versioned JSON store — the "Genie space"
lib/config.js     config.json settings, env-var overrides
```

The agent turn, end to end:

1. Retrieve the most relevant tables and example pairs from the context pack (keyword scoring; swap in embeddings later without touching the loop).
2. Build a system prompt: instructions → table schemas → join hints → retrieved examples → rules.
3. Ask Ollama. If the model replies in prose (ambiguous question), that's surfaced as a clarification instead of SQL.
4. Guardrail: only read statements (`SELECT`/`WITH`/`SHOW`/`DESCRIBE`/`EXPLAIN`) are executed.
5. Execute via `POST /api/2.0/sql/statements` (30s wait + polling, `row_limit` capped).
6. On failure, the Databricks error is fed back to the model for a fix — up to 2 retries. Every attempt is visible in the UI's statement trail.
7. A second small LLM call summarizes the result in a sentence or two.

Follow-up questions work: prior (question, successful SQL) turns are replayed as chat history.

## The data team workflow (context pack = Genie space)

| Genie space concept | Here |
| --- | --- |
| Included tables | **tables** tab (synced from Unity Catalog, descriptions/synonyms curated by hand) |
| General instructions | **instructions** tab |
| Example SQL / trusted assets | **examples** tab |
| Join hints | **relationships** tab |
| Sharing the space | **Export** → distribute the JSON → users **Import** (or ship it from S3/CloudFront later) |

The **preview** tab shows the exact prompt built for any question — use it to debug why the model picked the wrong table or missed an example.

Packs are versioned: every save bumps `version`, which is what you'd key a remote "pack update available" check on in the packaged app.

## Security notes (prototype-grade)

- The server binds `127.0.0.1` only. The PAT is stored in plain text in `config.json` — fine for a personal prototype; the packaged app should use OS keychain storage and Databricks U2M OAuth instead.
- The read-only statement guard is a client-side convenience, not a substitute for governance. Real enforcement is your PAT's Unity Catalog permissions — consider a token scoped to read-only access.

## Porting to Electron

The app was structured so the port is mostly packaging:

1. `npm i -D electron` and add a `main.js` that spawns `server.js` as a child process (or `require()`s it in the main process), waits for the port, then opens `new BrowserWindow().loadURL("http://127.0.0.1:4177")`.
2. Move `config.json` / `context-pack.json` paths to `app.getPath("userData")` so packaged builds are writable.
3. Replace the PAT flow with Databricks U2M OAuth (open the auth URL in a window, catch the redirect) and store tokens in `safeStorage`.
4. Bundle the model runtime as a sidecar (llama.cpp server binary spawned/killed with the app) instead of requiring a system Ollama install; keep the Ollama-compatible URL configurable so both work.
5. Auto-update: `electron-updater` against a manifest on CloudFront; context pack updates fetched separately by version on launch.

No frontend changes are required — it's a static bundle talking to localhost over relative paths.

## Upgrade path worth doing next

- **Embeddings retrieval**: `nomic-embed-text` via Ollama + `sqlite-vec`, replacing `lib/retrieval.js` scoring.
- **Streaming**: Ollama supports it; stream tokens into the statement card.
- **Result charts**: a bar/line toggle over the result table covers most stakeholder asks.
- **Feedback loop**: a 👍 on a good answer should offer "save as example" into the pack — that's how the pack compounds.

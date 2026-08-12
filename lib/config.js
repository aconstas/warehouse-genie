const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "config.json");

const DEFAULTS = {
  databricksHost: "",       // e.g. https://dbc-xxxx.cloud.databricks.com
  databricksToken: "",      // PAT — stored locally only
  warehouseId: "",          // SQL warehouse id
  ollamaUrl: "http://127.0.0.1:11434",
  ollamaModel: "qwen3",
  maxRetries: 2,
  rowLimit: 100
};

function load() {
  let fileCfg = {};
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch (_) { /* first run — no config file yet */ }
  if (raw !== undefined) {
    try {
      fileCfg = JSON.parse(raw);
    } catch (e) {
      // The file exists but is corrupt (e.g. crash mid-write). Fail loudly
      // instead of silently reverting to defaults and letting the next save
      // clobber recoverable data.
      throw new Error(`config.json is present but not valid JSON (${e.message}). Refusing to continue so it isn't overwritten — fix or delete ${CONFIG_PATH}.`);
    }
  }
  const cfg = { ...DEFAULTS, ...fileCfg };
  // Env overrides (useful for Electron packaging / CI)
  if (process.env.DATABRICKS_HOST) cfg.databricksHost = process.env.DATABRICKS_HOST;
  if (process.env.DATABRICKS_TOKEN) cfg.databricksToken = process.env.DATABRICKS_TOKEN;
  if (process.env.DATABRICKS_WAREHOUSE_ID) cfg.warehouseId = process.env.DATABRICKS_WAREHOUSE_ID;
  if (process.env.OLLAMA_URL) cfg.ollamaUrl = process.env.OLLAMA_URL;
  if (process.env.OLLAMA_MODEL) cfg.ollamaModel = process.env.OLLAMA_MODEL;
  return cfg;
}

function save(partial) {
  const current = load();
  const next = { ...current, ...partial };
  writeFileAtomic(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

/** Write via a temp file + rename so a crash can't leave a half-written file. */
function writeFileAtomic(filePath, contents) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

/** Redact secrets before sending config to the UI. */
function publicView(cfg) {
  return {
    ...cfg,
    databricksToken: cfg.databricksToken ? `••••${cfg.databricksToken.slice(-4)}` : "",
    hasToken: Boolean(cfg.databricksToken)
  };
}

module.exports = { load, save, publicView };

const fs = require("fs");
const path = require("path");

const PACK_PATH = path.join(__dirname, "..", "context-pack.json");

const EMPTY_PACK = {
  name: "Untitled context pack",
  version: 1,
  updated_at: null,
  instructions: "",
  tables: [],        // { full_name, description, synonyms: [], columns: [{name,type,comment}] }
  relationships: [], // { description }  e.g. "sales.deal_id joins to crm.deals.id"
  examples: []       // { question, sql, notes }
};

function load() {
  try {
    const pack = JSON.parse(fs.readFileSync(PACK_PATH, "utf8"));
    return { ...EMPTY_PACK, ...pack };
  } catch (_) {
    return { ...EMPTY_PACK };
  }
}

function save(pack) {
  const current = load();
  const next = {
    ...EMPTY_PACK,
    ...pack,
    version: (current.version || 0) + 1,
    updated_at: new Date().toISOString()
  };
  fs.writeFileSync(PACK_PATH, JSON.stringify(next, null, 2));
  return next;
}

/**
 * Merge tables pulled from Databricks into the pack.
 * Fresh column metadata wins; human-written descriptions and synonyms are preserved.
 */
function mergeSyncedTables(pack, syncedTables) {
  const existing = new Map(pack.tables.map((t) => [t.full_name, t]));
  for (const synced of syncedTables) {
    const prior = existing.get(synced.full_name);
    existing.set(synced.full_name, {
      full_name: synced.full_name,
      description: prior?.description || synced.description || "",
      synonyms: prior?.synonyms || [],
      columns: synced.columns.map((col) => {
        const priorCol = prior?.columns?.find((c) => c.name === col.name);
        return { ...col, comment: col.comment || priorCol?.comment || "" };
      })
    });
  }
  return { ...pack, tables: [...existing.values()] };
}

module.exports = { load, save, mergeSyncedTables, PACK_PATH };

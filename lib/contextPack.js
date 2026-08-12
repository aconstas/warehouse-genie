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
  let raw;
  try {
    raw = fs.readFileSync(PACK_PATH, "utf8");
  } catch (_) {
    return { ...EMPTY_PACK }; // first run — no pack file yet
  }
  let pack;
  try {
    pack = JSON.parse(raw);
  } catch (e) {
    // The pack is the team's curated asset. If the file is corrupt (e.g. crash
    // mid-write), fail loudly rather than silently returning an empty pack that
    // the next save would overwrite.
    throw new Error(`context-pack.json is present but not valid JSON (${e.message}). Refusing to continue so it isn't overwritten — fix or delete ${PACK_PATH}.`);
  }
  return { ...EMPTY_PACK, ...pack };
}

function save(pack) {
  const validated = validatePack(pack);
  const current = load();
  const next = {
    ...EMPTY_PACK,
    ...validated,
    version: (current.version || 0) + 1,
    updated_at: new Date().toISOString()
  };
  writeFileAtomic(PACK_PATH, JSON.stringify(next, null, 2));
  return next;
}

/** Reject a pack whose core collections are the wrong shape (bad import, etc.). */
function validatePack(pack) {
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) {
    throw new Error("Pack must be a JSON object.");
  }
  for (const key of ["tables", "relationships", "examples"]) {
    if (pack[key] !== undefined && !Array.isArray(pack[key])) {
      throw new Error(`Pack "${key}" must be an array.`);
    }
  }
  return pack;
}

/** Write via a temp file + rename so a crash can't leave a half-written file. */
function writeFileAtomic(filePath, contents) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
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

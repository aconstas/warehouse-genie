/**
 * Vector index for the context pack: text -> embedding cache -> cosine search.
 *
 * Storage is a per-space JSON sidecar (.genie/embeddings/<packId>.json) scanned
 * brute-force. A question is always asked against one space, so a query only
 * ever scans that space's vectors — ~100 dot products over 768 dims, i.e.
 * microseconds. That stays true at the ~20-space endgame, which is why this
 * isn't sqlite-vec: a native dependency would cost a compile step on install
 * and electron-rebuild per platform for no measurable win at this scale.
 *
 * Nothing here does HTTP; the embed call is injected so the whole module is
 * testable without Ollama.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ollama = require("./ollama");

const SCHEMA_VERSION = 1;
const DEFAULT_DIR = path.join(__dirname, "..", ".genie", "embeddings");
const BATCH_SIZE = 32;

/**
 * Asymmetric-search models want the query and the indexed document marked
 * differently — nomic-embed-text is trained that way and ranks measurably worse
 * without the prefixes. Swapping to mxbai/bge later is one entry here.
 */
const PREFIXES = {
  "nomic-embed-text": { doc: "search_document: ", query: "search_query: " }
};

function prefixesFor(model) {
  const family = String(model || "").split(":")[0];
  return PREFIXES[family] || { doc: "", query: "" };
}

/* ------------------------------------------------------------- pack -> text */

/** Mirrors what the lexical scorer indexes, so both signals see the same text. */
function tableText(t) {
  return [
    t.full_name,
    t.description || "",
    (t.synonyms || []).join(" "),
    (t.columns || []).map((c) => `${c.name} ${c.comment || ""}`).join(" ")
  ].join("\n").trim();
}

/** Deliberately excludes ex.sql — we match on how the question is phrased. */
function exampleText(ex) {
  return `${ex.question || ""} ${ex.notes || ""}`.trim();
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function tableKey(t) {
  return `table:${t.full_name}`;
}

/** Examples have no id, so key on the question — reordering the array must not
 *  invalidate the cache. */
function exampleKey(ex) {
  return `example:${sha256(String(ex.question || "")).slice(0, 16)}`;
}

/** Every embeddable item in a pack, as { key, text, hash }. */
function packEntries(pack) {
  const entries = [];
  for (const t of pack.tables || []) {
    const text = tableText(t);
    entries.push({ key: tableKey(t), text, hash: sha256(text) });
  }
  for (const ex of pack.examples || []) {
    const text = exampleText(ex);
    entries.push({ key: exampleKey(ex), text, hash: sha256(text) });
  }
  return entries;
}

/* --------------------------------------------------------------- vector math */

/** Store unit-length so query-time cosine is a bare dot product. */
function normalize(values) {
  const v = Float32Array.from(values);
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const mag = Math.sqrt(sum);
  if (!mag) return v;
  for (let i = 0; i < v.length; i++) v[i] /= mag;
  return v;
}

function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/** Base64-packed float32: ~4 KB per vector vs ~15 KB as a JSON number array. */
function encodeVec(v) {
  const f = v instanceof Float32Array ? v : Float32Array.from(v);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString("base64");
}

function decodeVec(b64) {
  const buf = Buffer.from(b64, "base64");
  // Buffer may be a view into a larger pooled ArrayBuffer — copy so the
  // Float32Array can't read past its own bytes.
  const copy = Buffer.allocUnsafe(buf.length);
  buf.copy(copy);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.length / 4);
}

/* --------------------------------------------------------------- rank fusion */

/**
 * Reciprocal rank fusion over one or more ranked key lists (best first).
 * Scale-free, which is what we need: the lexical score is an unbounded hit
 * count with no sensible normalization, so blending raw magnitudes against a
 * bounded cosine would need arbitrary calibration.
 */
function fuse(lists, { k = 60 } = {}) {
  const scores = new Map();
  for (const { keys, weight = 1 } of lists) {
    keys.forEach((key, i) => {
      scores.set(key, (scores.get(key) || 0) + weight / (k + i + 1));
    });
  }
  return scores;
}

/* ---------------------------------------------------------------- the store */

/** Slug of the pack name. When multi-space lands the pack loader should own a
 *  real stable id — slugs can collide across two similarly named spaces. */
function packIdFor(pack) {
  const slug = String(pack?.name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "default";
}

function emptyState(model) {
  return { schemaVersion: SCHEMA_VERSION, model, dim: 0, entries: {} };
}

/**
 * `dir` is a parameter, not a module constant: PACK_PATH and CONFIG_PATH being
 * hardcoded is exactly why contextPack.load/save and config.load/save have no
 * tests today.
 */
function createStore({ dir = DEFAULT_DIR, packId, model }) {
  const file = path.join(dir, `${packId}.json`);
  return {
    path: file,
    load() {
      let raw;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch (_) {
        return emptyState(model);
      }
      let state;
      try {
        state = JSON.parse(raw);
      } catch (_) {
        return emptyState(model); // a corrupt cache is disposable — just rebuild
      }
      // A different embedding model invalidates every vector in the file.
      if (state.schemaVersion !== SCHEMA_VERSION || state.model !== model) return emptyState(model);
      state.entries = state.entries || {};
      return state;
    },
    save(state) {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    }
  };
}

/* ---------------------------------------------------------------- the index */

/**
 * Bring the cache in line with the pack and return the decoded vectors.
 * Only entries whose text hash changed are re-embedded, so editing one table's
 * description costs one embed call, not one per table. (Note this is keyed on
 * content, NOT pack.version — that bumps on every save, cosmetic ones included.)
 */
async function ensureIndex({ cfg, pack, store, embed = ollama.embed, onProgress = null }) {
  const model = cfg.embeddingModel;
  const s = store || createStore({ packId: packIdFor(pack), model });
  const state = s.load();

  const desired = packEntries(pack);
  const wanted = new Set(desired.map((e) => e.key));
  const stale = desired.filter((e) => state.entries[e.key]?.hash !== e.hash);

  let pruned = 0;
  for (const key of Object.keys(state.entries)) {
    if (!wanted.has(key)) { delete state.entries[key]; pruned += 1; }
  }

  const { doc } = prefixesFor(model);
  let done = 0;
  for (let i = 0; i < stale.length; i += BATCH_SIZE) {
    const batch = stale.slice(i, i + BATCH_SIZE);
    const vectors = await embed(cfg, batch.map((e) => doc + e.text), { model });
    batch.forEach((entry, j) => {
      const v = normalize(vectors[j]);
      state.dim = v.length;
      state.entries[entry.key] = { hash: entry.hash, vec: encodeVec(v) };
    });
    done += batch.length;
    if (onProgress) onProgress({ done, total: stale.length });
  }

  state.model = model;
  state.schemaVersion = SCHEMA_VERSION;
  if (stale.length || pruned) s.save(state);

  const vectors = new Map();
  for (const [key, entry] of Object.entries(state.entries)) vectors.set(key, decodeVec(entry.vec));

  return { vectors, embedded: stale.length, cached: desired.length - stale.length, pruned, model, dim: state.dim };
}

/** Embed a user question (unit-length, query-prefixed). */
async function embedQuery({ cfg, question, embed = ollama.embed }) {
  const { query } = prefixesFor(cfg.embeddingModel);
  const [vec] = await embed(cfg, [query + String(question || "")], { model: cfg.embeddingModel });
  return normalize(vec);
}

module.exports = {
  createStore, ensureIndex, embedQuery, fuse, dot, normalize,
  encodeVec, decodeVec, packEntries, packIdFor,
  tableText, exampleText, tableKey, exampleKey, prefixesFor,
  DEFAULT_DIR, SCHEMA_VERSION
};

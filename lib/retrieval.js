/**
 * Hybrid retrieval: lexical keyword overlap fused with embedding similarity.
 *
 * Neither signal is sufficient alone. Keyword scoring nails exact identifiers
 * (a literal table name, campaign_id, an internal acronym) but returns nothing
 * when a stakeholder asks in business language that shares no tokens with the
 * schema. Vectors handle that vocabulary mismatch but are weak on identifiers.
 * So both run, and reciprocal-rank fusion combines them.
 *
 * The embedding path degrades to lexical whenever Ollama or the embedding model
 * is unavailable — a missing model must never fail a turn.
 */

const embeddings = require("./embeddings");

const RRF_K = 60;
/** Cosine is never 0 for real text, so the old `score > 0` example filter has no
 *  vector equivalent — an explicit floor is what keeps irrelevant examples out
 *  of every prompt. Tuned for nomic-embed-text; override with cfg.minSimilarity. */
const DEFAULT_MIN_SIMILARITY = 0.55;

const STOPWORDS = new Set([
  "the","a","an","of","for","to","in","on","by","and","or","is","are","was",
  "what","which","how","many","much","show","me","get","give","list","all",
  "per","with","from","that","this","last","top","do","we","i","our","us"
]);

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function score(queryTokens, docTokens) {
  if (!docTokens.length) return 0;
  const docSet = new Set(docTokens);
  let hits = 0;
  for (const t of queryTokens) {
    if (docSet.has(t)) hits += 1;
    else if (docTokens.some((d) => d.includes(t) || t.includes(d))) hits += 0.4; // partial: "session" ~ "sessions"
  }
  return hits;
}

/** Lexical scores for a set of candidates, best first. Ties keep pack order. */
function rankLexical(candidates, question) {
  const q = tokenize(question);
  return candidates
    .map((c, i) => ({ ...c, lex: score(q, tokenize(c.text)), i }))
    .sort((a, b) => b.lex - a.lex || a.i - b.i);
}

/* ------------------------------------------------------------- candidates */

function tableCandidates(pack) {
  return (pack.tables || []).map((t) => ({
    key: embeddings.tableKey(t),
    item: t,
    label: t.full_name,
    text: embeddings.tableText(t)
  }));
}

function exampleCandidates(pack) {
  return (pack.examples || []).map((ex) => ({
    key: embeddings.exampleKey(ex),
    item: ex,
    label: ex.question,
    text: embeddings.exampleText(ex)
  }));
}

/* ---------------------------------------------------------------- ranking */

/**
 * Merge the lexical and vector orderings into one ranked list.
 * In single-signal modes the surviving list is used directly, so a lexical-only
 * run ranks exactly as it did before this module gained embeddings.
 */
function rankHybrid(candidates, question, queryVec, vectors, mode) {
  const lex = rankLexical(candidates, question);
  const byKey = new Map(lex.map((c) => [c.key, c]));

  const useVec = queryVec && mode !== "lexical";
  const vec = useVec
    ? lex
        .map((c) => ({ key: c.key, cos: vectors.has(c.key) ? embeddings.dot(queryVec, vectors.get(c.key)) : null }))
        .filter((x) => x.cos !== null)
        .sort((a, b) => b.cos - a.cos)
    : [];
  const cosByKey = new Map(vec.map((v) => [v.key, v.cos]));

  let ordered;
  if (!useVec) {
    ordered = lex.map((c) => c.key);
  } else if (mode === "embedding") {
    // Vector-only: anything the index has no vector for falls to the back.
    ordered = [...vec.map((v) => v.key), ...lex.filter((c) => !cosByKey.has(c.key)).map((c) => c.key)];
  } else {
    const fused = embeddings.fuse(
      [{ keys: lex.map((c) => c.key) }, { keys: vec.map((v) => v.key) }],
      { k: RRF_K }
    );
    ordered = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  }
  const rrf = embeddings.fuse([{ keys: ordered }], { k: RRF_K });

  return ordered.map((key) => {
    const c = byKey.get(key);
    return { ...c, cos: cosByKey.has(key) ? cosByKey.get(key) : null, rrf: rrf.get(key) };
  });
}

/** Debug rows for the prompt-preview tab, rounded for readability. */
function toScoreRows(ranked, wasUsed) {
  return ranked.map((r, i) => ({
    label: r.label,
    lex: Number(r.lex.toFixed(2)),
    vec: r.cos === null ? null : Number(r.cos.toFixed(3)),
    rrf: Number(r.rrf.toFixed(5)),
    used: wasUsed(r, i)
  }));
}

/* ---------------------------------------------------------------- retrieve */

let warnedOnce = false;

/**
 * Rank tables and example pairs for one question.
 *
 * Returns bare pack objects (not {score, item} wrappers) — agent.renderTable and
 * the example rendering read t.columns[].name / ex.question directly.
 *
 * @returns {Promise<{tables, examples, mode, scores}>}
 */
async function retrieve({ cfg = {}, pack, question, maxTables, maxExamples, deps = {} }) {
  const topTables = maxTables ?? cfg.maxTables ?? 8;
  const topExamples = maxExamples ?? cfg.maxExamples ?? 4;
  const minSimilarity = cfg.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  let mode = cfg.retrievalMode || "hybrid";

  const tables = tableCandidates(pack);
  const examples = exampleCandidates(pack);

  // Small packs ship every table anyway, so ranking them is wasted work — but
  // examples still need ranking, so this only short-circuits the table list.
  const rankTables = tables.length > topTables;
  const needVectors = mode !== "lexical" && (rankTables || examples.length > 0);

  let queryVec = null;
  let vectors = new Map();
  if (needVectors) {
    try {
      const index = await (deps.ensureIndex || embeddings.ensureIndex)({ cfg, pack });
      vectors = index.vectors;
      queryVec = await (deps.embedQuery || embeddings.embedQuery)({ cfg, question });
    } catch (e) {
      // Ollama down or the embedding model was never pulled. Rank lexically and
      // say so, rather than failing the turn.
      if (!warnedOnce) {
        warnedOnce = true;
        console.warn(`[retrieval] embeddings unavailable, falling back to lexical: ${e.message}`);
      }
      queryVec = null;
      mode = "lexical-fallback";
    }
  } else if (mode !== "lexical") {
    mode = "lexical";
  }

  const rankedTables = rankHybrid(tables, question, queryVec, vectors, mode);
  const rankedExamples = rankHybrid(examples, question, queryVec, vectors, mode);

  // Tables get no relevance floor — the model needs something to work with, so
  // we always fill to topTables.
  const pickedTables = rankTables
    ? rankedTables.slice(0, topTables).map((r) => r.item)
    : tables.map((c) => c.item);

  const eligible = (r) => (r.lex > 0) || (r.cos !== null && r.cos >= minSimilarity);
  const keptExamples = rankedExamples.filter(eligible).slice(0, topExamples);
  const keptKeys = new Set(keptExamples.map((r) => r.key));

  return {
    tables: pickedTables,
    examples: keptExamples.map((r) => r.item),
    mode,
    scores: {
      minSimilarity,
      tables: toScoreRows(rankedTables, (_r, i) => !rankTables || i < topTables),
      examples: toScoreRows(rankedExamples, (r) => keptKeys.has(r.key))
    }
  };
}

module.exports = { retrieve, rankLexical, tokenize, score, DEFAULT_MIN_SIMILARITY, RRF_K };

/**
 * Lightweight lexical retrieval. Deterministic, zero dependencies, good enough
 * to prove the loop. The upgrade path is swapping score() for embedding
 * similarity (Ollama `nomic-embed-text` + sqlite-vec or pgvector) without
 * touching the agent.
 */

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

/** Rank tables by relevance. If the pack is small, just return everything. */
function selectTables(pack, question, maxTables = 8) {
  if (pack.tables.length <= maxTables) return pack.tables;
  const q = tokenize(question);
  return pack.tables
    .map((t) => {
      const doc = tokenize(
        [t.full_name, t.description, (t.synonyms || []).join(" "),
         t.columns.map((c) => `${c.name} ${c.comment}`).join(" ")].join(" ")
      );
      return { table: t, s: score(q, doc) };
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, maxTables)
    .map((x) => x.table);
}

/** Rank example question/SQL pairs; only keep ones with signal. */
function selectExamples(pack, question, maxExamples = 4) {
  const q = tokenize(question);
  return pack.examples
    .map((ex) => ({ ex, s: score(q, tokenize(ex.question + " " + (ex.notes || ""))) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, maxExamples)
    .map((x) => x.ex);
}

module.exports = { selectTables, selectExamples };

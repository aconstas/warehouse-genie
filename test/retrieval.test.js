const test = require("node:test");
const assert = require("node:assert/strict");

const { retrieve } = require("../lib/retrieval");
const { tableKey, exampleKey, normalize } = require("../lib/embeddings");

function table(full_name, description = "", columns = [], synonyms = []) {
  return { full_name, description, synonyms, columns };
}

/** Hand-built vectors keyed by pack entry, so ranking is fully deterministic. */
function fakeIndex(vectorsByKey) {
  const vectors = new Map(Object.entries(vectorsByKey).map(([k, v]) => [k, normalize(v)]));
  return {
    ensureIndex: async () => ({ vectors }),
    embedQuery: async () => normalize([1, 0, 0])
  };
}

/* --------------------------------------------------------------- lexical */

test("retrieve: returns every table when the pack is smaller than the cap", async () => {
  const pack = { tables: [table("a.b.c"), table("a.b.d")], examples: [] };
  const { tables } = await retrieve({ cfg: { retrievalMode: "lexical" }, pack, question: "anything" });
  assert.deepEqual(tables.map((t) => t.full_name), ["a.b.c", "a.b.d"]);
});

test("retrieve: ranks the relevant table first when the pack is large", async () => {
  const tables = [];
  for (let i = 0; i < 10; i++) tables.push(table(`cat.sch.filler_${i}`, "misc"));
  tables.push(table("cat.sch.campaign_performance_daily", "daily media spend by campaign",
    [{ name: "spend", type: "double", comment: "" }, { name: "campaign_id", type: "string", comment: "" }]));
  const pack = { tables, examples: [] };
  const res = await retrieve({
    cfg: { retrievalMode: "lexical" }, pack, question: "total spend by campaign", maxTables: 3
  });
  assert.equal(res.tables.length, 3);
  assert.equal(res.tables[0].full_name, "cat.sch.campaign_performance_daily");
});

test("retrieve: keeps only examples with lexical signal, ranked", async () => {
  const pack = {
    tables: [],
    examples: [
      { question: "total spend by platform", sql: "SELECT 1", notes: "" },
      { question: "unrelated question about weather", sql: "SELECT 2", notes: "" }
    ]
  };
  const { examples } = await retrieve({
    cfg: { retrievalMode: "lexical" }, pack, question: "what was spend by platform last month", maxExamples: 4
  });
  assert.equal(examples.length, 1);
  assert.equal(examples[0].sql, "SELECT 1");
});

/* ---------------------------------------------------------------- hybrid */

test("retrieve: fusion lets a strong vector match outrank a better lexical one", async () => {
  const tables = [];
  for (let i = 0; i < 10; i++) tables.push(table(`cat.sch.filler_${i}`, "misc"));
  // Shares the query token "spend", so it wins lexically.
  tables.push(table("cat.sch.lexical_winner", "spend"));
  // Shares nothing lexically, but sits right on the query vector.
  tables.push(table("cat.sch.vector_winner", "widget freshness"));
  const pack = { tables, examples: [] };

  const deps = fakeIndex({
    [tableKey({ full_name: "cat.sch.vector_winner" })]: [1, 0, 0],
    [tableKey({ full_name: "cat.sch.lexical_winner" })]: [0, 1, 0]
  });

  const lexical = await retrieve({
    cfg: { retrievalMode: "lexical" }, pack, question: "spend", maxTables: 2
  });
  assert.equal(lexical.tables[0].full_name, "cat.sch.lexical_winner");

  const hybrid = await retrieve({ cfg: {}, pack, question: "spend", maxTables: 2, deps });
  assert.equal(hybrid.mode, "hybrid");
  // Rank 1 by vector + rank 1 by lexical tie at the top; both must survive the
  // cut, which is the point of fusing rather than picking one signal.
  const picked = hybrid.tables.map((t) => t.full_name);
  assert.ok(picked.includes("cat.sch.vector_winner"), `expected vector winner in ${picked}`);
  assert.ok(picked.includes("cat.sch.lexical_winner"), `expected lexical winner in ${picked}`);
});

test("retrieve: an example sharing no tokens with the question is still retrieved", async () => {
  const pack = {
    tables: [],
    examples: [
      { question: "which widgets are stale", sql: "SELECT 1", notes: "" },
      { question: "completely different topic", sql: "SELECT 2", notes: "" }
    ]
  };
  const question = "list unrefreshed inventory items";
  const deps = fakeIndex({
    [exampleKey({ question: "which widgets are stale" })]: [1, 0.05, 0],
    [exampleKey({ question: "completely different topic" })]: [0, 1, 0]
  });

  // Lexical alone finds nothing — no shared tokens at all.
  const lexical = await retrieve({ cfg: { retrievalMode: "lexical" }, pack, question });
  assert.equal(lexical.examples.length, 0);

  const hybrid = await retrieve({ cfg: {}, pack, question, deps });
  assert.equal(hybrid.examples.length, 1);
  assert.equal(hybrid.examples[0].sql, "SELECT 1");
});

test("retrieve: an example below the similarity floor is excluded", async () => {
  const pack = { tables: [], examples: [{ question: "completely different topic", sql: "SELECT 2", notes: "" }] };
  const deps = fakeIndex({
    [exampleKey({ question: "completely different topic" })]: [0.3, 1, 0] // cos ≈ 0.29
  });
  const { examples } = await retrieve({ cfg: {}, pack, question: "list unrefreshed inventory", deps });
  assert.equal(examples.length, 0, "cosine is never zero, so an explicit floor is what keeps noise out");
});

/* -------------------------------------------------------------- fallback */

test("retrieve: falls back to lexical when embedding fails, without throwing", async () => {
  const tables = [];
  for (let i = 0; i < 10; i++) tables.push(table(`cat.sch.filler_${i}`, "misc"));
  tables.push(table("cat.sch.spend_daily", "daily media spend by campaign"));
  const pack = { tables, examples: [] };

  const deps = {
    ensureIndex: async () => { throw new Error("model 'nomic-embed-text' not found"); },
    embedQuery: async () => { throw new Error("unreachable"); }
  };

  const res = await retrieve({ cfg: {}, pack, question: "total spend by campaign", maxTables: 3, deps });
  assert.equal(res.mode, "lexical-fallback");
  assert.equal(res.tables[0].full_name, "cat.sch.spend_daily");
});

/* ----------------------------------------------------------------- scores */

test("retrieve: reports per-candidate scores for the preview tab", async () => {
  const tables = [];
  for (let i = 0; i < 10; i++) tables.push(table(`cat.sch.filler_${i}`, "misc"));
  tables.push(table("cat.sch.spend_daily", "daily media spend by campaign"));
  const pack = { tables, examples: [] };

  const { scores } = await retrieve({
    cfg: { retrievalMode: "lexical" }, pack, question: "total spend by campaign", maxTables: 2
  });
  assert.equal(scores.tables.length, 11, "every candidate is reported, not just the winners");
  assert.equal(scores.tables[0].label, "cat.sch.spend_daily");
  assert.equal(scores.tables[0].used, true);
  assert.equal(scores.tables[0].vec, null, "no vector signal in lexical mode");
  assert.equal(scores.tables.at(-1).used, false);
});

const test = require("node:test");
const assert = require("node:assert/strict");

const { selectTables, selectExamples } = require("../lib/retrieval");

function table(full_name, description = "", columns = [], synonyms = []) {
  return { full_name, description, synonyms, columns };
}

test("selectTables: returns everything when the pack is small", () => {
  const pack = { tables: [table("a.b.c"), table("a.b.d")], examples: [] };
  assert.deepEqual(selectTables(pack, "anything").map((t) => t.full_name), ["a.b.c", "a.b.d"]);
});

test("selectTables: ranks the relevant table first when the pack is large", () => {
  const tables = [];
  for (let i = 0; i < 10; i++) tables.push(table(`cat.sch.filler_${i}`, "misc"));
  tables.push(table("cat.sch.campaign_performance_daily", "daily media spend by campaign",
    [{ name: "spend", type: "double", comment: "" }, { name: "campaign_id", type: "string", comment: "" }]));
  const pack = { tables, examples: [] };
  const ranked = selectTables(pack, "total spend by campaign", 3);
  assert.equal(ranked.length, 3);
  assert.equal(ranked[0].full_name, "cat.sch.campaign_performance_daily");
});

test("selectExamples: keeps only examples with lexical signal, ranked", () => {
  const pack = {
    tables: [],
    examples: [
      { question: "total spend by platform", sql: "SELECT 1", notes: "" },
      { question: "unrelated question about weather", sql: "SELECT 2", notes: "" }
    ]
  };
  const picked = selectExamples(pack, "what was spend by platform last month", 4);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].sql, "SELECT 1");
});

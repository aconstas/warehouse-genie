const test = require("node:test");
const assert = require("node:assert/strict");

const { mergeSyncedTables } = require("../lib/contextPack");

test("mergeSyncedTables: preserves human descriptions and synonyms on re-sync", () => {
  const pack = {
    tables: [{
      full_name: "c.s.t",
      description: "hand-written grain note",
      synonyms: ["media perf"],
      columns: [{ name: "spend", type: "double", comment: "human comment" }]
    }],
    relationships: [], examples: []
  };
  const synced = [{
    full_name: "c.s.t",
    description: "uc comment (should not win)",
    columns: [{ name: "spend", type: "double", comment: "" }]
  }];

  const merged = mergeSyncedTables(pack, synced);
  const t = merged.tables.find((x) => x.full_name === "c.s.t");
  assert.equal(t.description, "hand-written grain note");
  assert.deepEqual(t.synonyms, ["media perf"]);
  // Fresh sync had no comment, so the prior human column comment is retained.
  assert.equal(t.columns[0].comment, "human comment");
});

test("mergeSyncedTables: fresh UC column comment wins over stale local one", () => {
  const pack = {
    tables: [{
      full_name: "c.s.t", description: "", synonyms: [],
      columns: [{ name: "spend", type: "double", comment: "stale" }]
    }],
    relationships: [], examples: []
  };
  const synced = [{
    full_name: "c.s.t", description: "",
    columns: [{ name: "spend", type: "double", comment: "fresh from UC" }]
  }];

  const merged = mergeSyncedTables(pack, synced);
  assert.equal(merged.tables[0].columns[0].comment, "fresh from UC");
});

test("mergeSyncedTables: adds brand-new tables", () => {
  const pack = { tables: [], relationships: [], examples: [] };
  const synced = [{ full_name: "c.s.new", description: "d", columns: [] }];
  const merged = mergeSyncedTables(pack, synced);
  assert.equal(merged.tables.length, 1);
  assert.equal(merged.tables[0].full_name, "c.s.new");
});

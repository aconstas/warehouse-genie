const test = require("node:test");
const assert = require("node:assert/strict");

const { toNumber, classifyColumns, inferChart, sameScaleGroup, niceTicks } = require("../public/charts");

test("toNumber parses stringified numbers, rejects junk", () => {
  assert.equal(toNumber("0.2386"), 0.2386);
  assert.equal(toNumber("1,234"), 1234);
  assert.equal(toNumber(42), 42);
  assert.equal(toNumber(""), null);
  assert.equal(toNumber(null), null);
  assert.equal(toNumber("n/a"), null);
});

test("classifyColumns: type strings then value fallback", () => {
  const cols = [{ name: "d", type: "DATE" }, { name: "c", type: "STRING" }, { name: "n", type: "DOUBLE" }, { name: "u", type: "" }];
  const rows = [["2024-01-01", "GMA", "0.5", "10"], ["2024-02-01", "HMA", "0.6", "20"]];
  assert.deepEqual(classifyColumns(cols, rows), ["date", "category", "number", "number"]);
});

test("inferChart: date + numeric -> line over the date", () => {
  const cols = [{ name: "date_month", type: "DATE" }, { name: "win_rate", type: "DOUBLE" }];
  const rows = [["2024-01-01", "0.2"], ["2024-02-01", "0.25"], ["2024-03-01", "0.3"]];
  const r = inferChart(cols, rows);
  assert.equal(r.chartable, true);
  assert.equal(r.type, "line");
  assert.equal(r.xIndex, 0);
  assert.deepEqual(r.yIndexes, [1]);
});

test("inferChart: category + numeric -> bar over the category", () => {
  const cols = [{ name: "brand", type: "STRING" }, { name: "cnt", type: "BIGINT" }];
  const rows = [["GMA", "100"], ["HMA", "220"]];
  const r = inferChart(cols, rows);
  assert.equal(r.type, "bar");
  assert.equal(r.xIndex, 0);
});

test("inferChart: two numerics, no date/category -> scatter", () => {
  const cols = [{ name: "spend", type: "DOUBLE" }, { name: "conv", type: "DOUBLE" }];
  const rows = [["1.0", "2.0"], ["3.0", "4.0"], ["5.0", "1.0"]];
  const r = inferChart(cols, rows);
  assert.equal(r.type, "scatter");
  assert.equal(r.xIndex, 0);
  assert.deepEqual(r.yIndexes, [1]);
});

test("inferChart: not chartable when no numeric column or <2 rows", () => {
  assert.equal(inferChart([{ name: "a", type: "STRING" }], [["x"], ["y"]]).chartable, false);
  assert.equal(inferChart([{ name: "n", type: "DOUBLE" }], [["1"]]).chartable, false);
});

test("sameScaleGroup drops a column that dwarfs the first (rate vs count)", () => {
  // series 0 is a rate (~0.3), series 1 a count (~5000) -> only the rate kept by default
  const rows = [["0.3", "5000"], ["0.4", "6000"]];
  assert.deepEqual(sameScaleGroup([0, 1], rows), [0]);
  // two comparable rates stay together
  const rows2 = [["0.3", "0.5"], ["0.4", "0.55"]];
  assert.deepEqual(sameScaleGroup([0, 1], rows2), [0, 1]);
});

test("niceTicks produces rounded, covering ticks", () => {
  const t = niceTicks(0, 0.3, 5);
  assert.ok(t[0] <= 0 && t[t.length - 1] >= 0.3);
  assert.ok(t.length >= 3);
});

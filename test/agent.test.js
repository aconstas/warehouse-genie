const test = require("node:test");
const assert = require("node:assert/strict");

const { isReadOnly, extractSql } = require("../lib/agent");

test("isReadOnly: allows plain read statements", () => {
  for (const sql of [
    "SELECT 1",
    "select * from main.gold.sales limit 10",
    "WITH x AS (SELECT 1) SELECT * FROM x",
    "SHOW TABLES",
    "DESCRIBE main.gold.sales",
    "EXPLAIN SELECT 1"
  ]) {
    assert.equal(isReadOnly(sql), true, sql);
  }
});

test("isReadOnly: blocks the CTE-prefixed mutation bypass", () => {
  for (const sql of [
    "WITH x AS (SELECT 1) INSERT INTO main.gold.t SELECT * FROM x",
    "with c as (select 1) update main.gold.t set a = 1",
    "WITH c AS (SELECT 1) DELETE FROM main.gold.t",
    "WITH c AS (SELECT 1) MERGE INTO main.gold.t USING c ON true"
  ]) {
    assert.equal(isReadOnly(sql), false, sql);
  }
});

test("isReadOnly: blocks bare mutations and DDL/DCL", () => {
  for (const sql of [
    "INSERT INTO t VALUES (1)",
    "UPDATE t SET a = 1",
    "DELETE FROM t",
    "DROP TABLE t",
    "CREATE TABLE t (a int)",
    "ALTER TABLE t ADD COLUMN b int",
    "TRUNCATE TABLE t",
    "GRANT SELECT ON t TO u",
    "REVOKE SELECT ON t FROM u"
  ]) {
    assert.equal(isReadOnly(sql), false, sql);
  }
});

test("isReadOnly: mutation keyword hidden in a comment does not block a real read", () => {
  assert.equal(isReadOnly("-- todo: insert results into cache\nSELECT 1"), true);
  assert.equal(isReadOnly("SELECT 1 /* do not delete this query */"), true);
});

test("isReadOnly: leading comment before SELECT is still allowed", () => {
  assert.equal(isReadOnly("-- note\nSELECT 1"), true);
  assert.equal(isReadOnly("/* header */ SELECT 1"), true);
});

test("isReadOnly: mutation keyword inside a string literal does not block a read", () => {
  assert.equal(isReadOnly("SELECT * FROM t WHERE action = 'delete'"), true);
});

test("extractSql: pulls SQL from a fenced block", () => {
  assert.equal(extractSql("```sql\nSELECT 1\n```"), "SELECT 1");
  assert.equal(extractSql("here you go:\n```\nSELECT 2\n```"), "SELECT 2");
});

test("extractSql: accepts bare SQL when it looks like a statement", () => {
  assert.equal(extractSql("SELECT 1"), "SELECT 1");
  assert.equal(extractSql("WITH x AS (SELECT 1) SELECT * FROM x"), "WITH x AS (SELECT 1) SELECT * FROM x");
});

test("extractSql: returns null for a plain-text clarification", () => {
  assert.equal(extractSql("I need to know which time range you mean."), null);
});

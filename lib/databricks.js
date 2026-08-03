/**
 * Databricks SQL Statement Execution API client.
 * Docs: POST /api/2.0/sql/statements  (wait_timeout + polling for long queries)
 */

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELED", "CLOSED"]);
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_MS = 90_000;

function headers(cfg) {
  return {
    Authorization: `Bearer ${cfg.databricksToken}`,
    "Content-Type": "application/json"
  };
}

function assertConfigured(cfg) {
  if (!cfg.databricksHost || !cfg.databricksToken || !cfg.warehouseId) {
    const missing = [
      !cfg.databricksHost && "workspace host",
      !cfg.databricksToken && "access token",
      !cfg.warehouseId && "warehouse id"
    ].filter(Boolean).join(", ");
    const err = new Error(`Databricks connection not configured (missing: ${missing}). Open Settings to add them.`);
    err.code = "NOT_CONFIGURED";
    throw err;
  }
}

/**
 * Execute a SQL statement. Resolves to:
 *   { ok: true, columns: [{name,type}], rows: [[...]], rowCount, truncated }
 *   { ok: false, error: "message" }
 */
async function executeStatement(cfg, sql, { rowLimit } = {}) {
  assertConfigured(cfg);
  const base = cfg.databricksHost.replace(/\/+$/, "");

  const res = await fetch(`${base}/api/2.0/sql/statements/`, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify({
      statement: sql,
      warehouse_id: cfg.warehouseId,
      wait_timeout: "30s",
      on_wait_timeout: "CONTINUE",
      row_limit: rowLimit || cfg.rowLimit || 100,
      format: "JSON_ARRAY",
      disposition: "INLINE"
    })
  });

  if (!res.ok) {
    const body = await safeText(res);
    return { ok: false, error: `Databricks API ${res.status}: ${body}` };
  }

  let payload = await res.json();

  // Poll until terminal state if the warehouse is still working (or waking up)
  const started = Date.now();
  while (!TERMINAL.has(payload.status?.state)) {
    if (Date.now() - started > MAX_POLL_MS) {
      return { ok: false, error: "Query timed out after 90s. The warehouse may be starting up — try again in a minute." };
    }
    await sleep(POLL_INTERVAL_MS);
    const poll = await fetch(`${base}/api/2.0/sql/statements/${payload.statement_id}`, { headers: headers(cfg) });
    if (!poll.ok) {
      const body = await safeText(poll);
      return { ok: false, error: `Databricks polling error ${poll.status}: ${body}` };
    }
    payload = await poll.json();
  }

  if (payload.status.state !== "SUCCEEDED") {
    const msg = payload.status?.error?.message || `Statement ${payload.status.state}`;
    return { ok: false, error: msg };
  }

  const columns = (payload.manifest?.schema?.columns || []).map((c) => ({
    name: c.name,
    type: c.type_text || c.type_name || ""
  }));
  const rows = payload.result?.data_array || [];
  const totalRows = payload.manifest?.total_row_count ?? rows.length;
  return {
    ok: true,
    columns,
    rows,
    rowCount: rows.length,
    truncated: payload.result?.truncated || totalRows > rows.length
  };
}

/**
 * Pull table + column metadata for a catalog.schema via information_schema.
 * Returns [{ full_name, description, columns: [{name, type, comment}] }]
 */
async function fetchSchemaMetadata(cfg, catalog, schema, tableFilter) {
  const cat = quoteIdent(catalog);
  const filterClause = tableFilter && tableFilter.length
    ? `AND c.table_name IN (${tableFilter.map(sqlString).join(", ")})`
    : "";

  const sql = `
    SELECT
      c.table_name,
      c.column_name,
      c.full_data_type,
      c.comment AS column_comment,
      t.comment AS table_comment,
      c.ordinal_position
    FROM ${cat}.information_schema.columns c
    JOIN ${cat}.information_schema.tables t
      ON t.table_catalog = c.table_catalog
     AND t.table_schema  = c.table_schema
     AND t.table_name    = c.table_name
    WHERE c.table_schema = ${sqlString(schema)}
      ${filterClause}
    ORDER BY c.table_name, c.ordinal_position
  `;

  const result = await executeStatement(cfg, sql, { rowLimit: 5000 });
  if (!result.ok) throw new Error(result.error);

  const byTable = new Map();
  for (const [tableName, columnName, dataType, colComment, tblComment] of result.rows) {
    const fullName = `${catalog}.${schema}.${tableName}`;
    if (!byTable.has(fullName)) {
      byTable.set(fullName, {
        full_name: fullName,
        description: tblComment || "",
        columns: []
      });
    }
    byTable.get(fullName).columns.push({
      name: columnName,
      type: dataType || "",
      comment: colComment || ""
    });
  }
  return [...byTable.values()];
}

/** Lightweight connectivity check: fetch the configured warehouse. */
async function health(cfg) {
  try {
    assertConfigured(cfg);
    const base = cfg.databricksHost.replace(/\/+$/, "");
    const res = await fetch(`${base}/api/2.0/sql/warehouses/${cfg.warehouseId}`, { headers: headers(cfg) });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const wh = await res.json();
    return { ok: true, detail: `${wh.name} (${wh.state})` };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

function quoteIdent(name) {
  return "`" + String(name).replace(/`/g, "``") + "`";
}
function sqlString(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}
async function safeText(res) {
  try { return (await res.text()).slice(0, 500); } catch { return "(no body)"; }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { executeStatement, fetchSchemaMetadata, health };

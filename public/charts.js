/* Warehouse Genie — hand-rolled inline-SVG charts. Zero dependencies, fully
   offline. Exposes globals in the browser (renderChart, inferChart, …) and a
   CommonJS export under Node so the pure helpers can be unit-tested.

   Palette: validated (dark-mode, surface #161d26) against the data-viz six
   checks — lightness band, chroma floor, CVD ΔE, normal-vision floor, contrast.
   Fixed order, never cycled; a 7th+ series folds into "Other". */

const CHART_PALETTE = ["#3b82d9", "#c67f22", "#17a888", "#e0674a", "#9a63e0", "#5c9636"];

const NUMBER_TYPE = /\b(int|integer|bigint|smallint|tinyint|long|double|float|real|decimal|numeric|number)\b/i;
const DATE_TYPE = /\b(date|timestamp|datetime)\b/i;

/* ------------------------------------------------------------ pure helpers */

function toNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Role of each column: "number" | "date" | "category". Type string first,
 *  then fall back to whether the sampled values parse as numbers. */
function classifyColumns(columns, rows) {
  const sample = rows.slice(0, 25);
  return columns.map((c, i) => {
    const type = c.type || "";
    if (DATE_TYPE.test(type)) return "date";
    if (NUMBER_TYPE.test(type)) return "number";
    // Fallback: if every non-null sampled value parses numerically, treat as number.
    const vals = sample.map((r) => r[i]).filter((v) => v !== null && v !== "");
    if (vals.length && vals.every((v) => toNumber(v) !== null)) return "number";
    return "category";
  });
}

/**
 * Pick a sensible default chart for a result set.
 * Returns { chartable, type, xIndex, yIndexes, roles }.
 *  - x = first date column, else first category column, else (>=2 numeric and no
 *    date/category) the first numeric → scatter, else the row index.
 *  - y = numeric columns (excluding x), defaulted to the same-magnitude group as
 *    the first series so a rate (0..1) and a count (10000) don't share one axis.
 */
function inferChart(columns, rows) {
  const roles = classifyColumns(columns, rows);
  const numeric = roles.map((r, i) => (r === "number" ? i : -1)).filter((i) => i >= 0);
  const dates = roles.map((r, i) => (r === "date" ? i : -1)).filter((i) => i >= 0);
  const cats = roles.map((r, i) => (r === "category" ? i : -1)).filter((i) => i >= 0);

  const notChartable = { chartable: false, type: "bar", xIndex: -1, yIndexes: [], roles };
  if (numeric.length === 0 || rows.length < 2) return notChartable;

  let type, xIndex, yPool;
  if (dates.length) {
    type = "line"; xIndex = dates[0]; yPool = numeric;
  } else if (cats.length) {
    type = "bar"; xIndex = cats[0]; yPool = numeric;
  } else if (numeric.length >= 2) {
    type = "scatter"; xIndex = numeric[0]; yPool = numeric.slice(1);
  } else {
    type = "bar"; xIndex = -1; yPool = numeric; // x = row index
  }

  const yIndexes = sameScaleGroup(yPool, rows);
  if (!yIndexes.length) return notChartable;
  return { chartable: true, type, xIndex, yIndexes, roles };
}

/** From candidate numeric columns, keep the first plus any whose magnitude is
 *  within ~50x of it — one shared y-axis stays honest (no dual scales). */
function sameScaleGroup(cols, rows) {
  if (cols.length <= 1) return cols.slice();
  const mag = (ci) => {
    let max = 0;
    for (const r of rows) { const n = toNumber(r[ci]); if (n !== null) max = Math.max(max, Math.abs(n)); }
    return max;
  };
  const base = mag(cols[0]) || 1;
  return cols.filter((ci) => {
    const m = mag(ci) || 1;
    const ratio = m > base ? m / base : base / m;
    return ratio <= 50;
  });
}

/** "Nice" axis ticks covering [min,max] — rounded 1/2/5×10ⁿ steps. */
function niceTicks(min, max, count = 5) {
  if (min === max) { min -= 1; max += 1; }
  const span = niceNum(max - min, false);
  const step = niceNum(span / Math.max(1, count - 1), true);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

function niceNum(range, round) {
  const exp = Math.floor(Math.log10(range || 1));
  const frac = (range || 1) / Math.pow(10, exp);
  let nf;
  if (round) nf = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
  else nf = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nf * Math.pow(10, exp);
}

function scaleLinear(d0, d1, r0, r1) {
  const span = d1 - d0 || 1;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

function seriesColor(i) {
  return CHART_PALETTE[i % CHART_PALETTE.length];
}

/* ---------------------------------------------------------- SVG rendering */
/* (browser-only below — guarded helpers above are what the tests import) */

const escSvg = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmtNum = (n) => {
  if (n === null || n === undefined) return "";
  const a = Math.abs(n);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return n.toExponential(2);
  if (Number.isInteger(n)) return n.toLocaleString();
  return (+n.toFixed(a < 1 ? 4 : 2)).toLocaleString();
};

const VB_W = 760, VB_H = 380;
const M = { top: 18, right: 18, bottom: 54, left: 62 };

/** Render a chart to an SVG string. opts = { type, xIndex, yIndexes }. */
function renderChart(result, opts) {
  const { columns, rows } = result;
  const type = opts.type || "line";
  const xIndex = opts.xIndex;
  const yIndexes = (opts.yIndexes && opts.yIndexes.length ? opts.yIndexes : []).slice(0, CHART_PALETTE.length);
  if (!yIndexes.length) return `<div class="chart-empty">Nothing numeric to plot.</div>`;

  const plotW = VB_W - M.left - M.right;
  const plotH = VB_H - M.top - M.bottom;
  const x0 = M.left, x1 = M.left + plotW, y0 = M.top + plotH, y1 = M.top;

  // y domain across all selected series
  let yMin = Infinity, yMax = -Infinity;
  for (const ci of yIndexes) for (const r of rows) {
    const n = toNumber(r[ci]); if (n === null) continue;
    if (n < yMin) yMin = n; if (n > yMax) yMax = n;
  }
  if (!Number.isFinite(yMin)) { yMin = 0; yMax = 1; }
  if (type !== "scatter") yMin = Math.min(yMin, 0); // bars/lines anchor at 0 baseline
  const ticks = niceTicks(yMin, yMax, 5);
  const yLo = ticks[0], yHi = ticks[ticks.length - 1];
  const yScale = scaleLinear(yLo, yHi, y0, y1);

  const svgParts = [];
  // y gridlines + labels
  for (const t of ticks) {
    const yy = yScale(t).toFixed(1);
    svgParts.push(`<line class="chart-grid" x1="${x0}" y1="${yy}" x2="${x1}" y2="${yy}"/>`);
    svgParts.push(`<text class="chart-axis-label" x="${x0 - 8}" y="${yy}" text-anchor="end" dominant-baseline="middle">${escSvg(fmtNum(t))}</text>`);
  }

  const labels = rows.map((r) => (xIndex >= 0 ? r[xIndex] : ""));

  if (type === "scatter") {
    svgParts.push(scatterBody(rows, xIndex, yIndexes, columns, x0, x1, yScale));
  } else if (type === "bar") {
    svgParts.push(barBody(rows, yIndexes, columns, labels, x0, plotW, y0, yScale));
  } else {
    svgParts.push(lineBody(rows, yIndexes, columns, labels, x0, plotW, yScale));
  }

  // x-axis labels (categorical/date/scatter share a thinned label strip)
  svgParts.push(xAxis(type, rows, xIndex, labels, x0, x1, plotW, y0));

  // axis frame (baseline + y line)
  svgParts.push(`<line class="chart-axis" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y0}"/>`);
  svgParts.push(`<line class="chart-axis" x1="${x0}" y1="${y1}" x2="${x0}" y2="${y0}"/>`);

  const legend = yIndexes.length > 1
    ? `<div class="chart-legend">${yIndexes.map((ci, i) =>
        `<span class="chart-leg"><span class="chart-swatch" style="background:${seriesColor(i)}"></span>${escSvg(columns[ci].name)}</span>`).join("")}</div>`
    : "";

  return `
    <div class="chart-wrap">
      <svg class="chart" viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="xMidYMid meet" role="img">
        ${svgParts.join("\n")}
      </svg>
      ${legend}
    </div>`;
}

function lineBody(rows, yIndexes, columns, labels, x0, plotW, yScale) {
  const n = rows.length;
  const xAt = (i) => x0 + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  let out = "";
  yIndexes.forEach((ci, s) => {
    const color = seriesColor(s);
    const pts = [];
    rows.forEach((r, i) => { const v = toNumber(r[ci]); if (v !== null) pts.push([xAt(i), yScale(v), i, v]); });
    if (!pts.length) return;
    const d = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    out += `<polyline class="chart-line" points="${d}" style="stroke:${color}"/>`;
    out += pts.map((p) =>
      `<circle class="chart-dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.5" style="fill:${color}" `
      + `data-label="${escSvg(columns[ci].name)}" data-x="${escSvg(labels[p[2]] ?? p[2] + 1)}" data-value="${escSvg(fmtNum(p[3]))}"/>`).join("");
  });
  return out;
}

function barBody(rows, yIndexes, columns, labels, x0, plotW, y0, yScale) {
  const groups = rows.length;
  const gpad = 0.28;                       // gap between category groups (fraction)
  const gw = plotW / groups;
  const inner = gw * (1 - gpad);
  const bw = inner / yIndexes.length;
  let out = "";
  rows.forEach((r, gi) => {
    const gx = x0 + gi * gw + (gw - inner) / 2;
    yIndexes.forEach((ci, s) => {
      const v = toNumber(r[ci]); if (v === null) return;
      const yy = yScale(v), h = Math.max(0, y0 - yy);
      const bx = gx + s * bw;
      out += `<rect class="chart-bar" x="${bx.toFixed(1)}" y="${yy.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="3" style="fill:${seriesColor(s)}" `
        + `data-label="${escSvg(columns[ci].name)}" data-x="${escSvg(labels[gi] ?? gi)}" data-value="${escSvg(fmtNum(v))}"/>`;
    });
  });
  return out;
}

function scatterBody(rows, xIndex, yIndexes, columns, x0, x1, yScale) {
  let xMin = Infinity, xMax = -Infinity;
  for (const r of rows) { const n = toNumber(r[xIndex]); if (n === null) continue; if (n < xMin) xMin = n; if (n > xMax) xMax = n; }
  if (!Number.isFinite(xMin)) { xMin = 0; xMax = 1; }
  const xt = niceTicks(xMin, xMax, 5);
  const xScale = scaleLinear(xt[0], xt[xt.length - 1], x0, x1);
  let out = "";
  yIndexes.forEach((ci, s) => {
    const color = seriesColor(s);
    out += rows.map((r) => {
      const xv = toNumber(r[xIndex]), yv = toNumber(r[ci]);
      if (xv === null || yv === null) return "";
      return `<circle class="chart-dot" cx="${xScale(xv).toFixed(1)}" cy="${yScale(yv).toFixed(1)}" r="4.5" style="fill:${color};fill-opacity:0.82" `
        + `data-label="${escSvg(columns[ci].name)}" data-x="${escSvg(fmtNum(xv))}" data-value="${escSvg(fmtNum(yv))}"/>`;
    }).join("");
  });
  return out;
}

function xAxis(type, rows, xIndex, labels, x0, x1, plotW, y0) {
  if (type === "scatter") return ""; // scatter x is numeric; ticks omitted for compactness
  const n = rows.length;
  const maxLabels = 12;
  const stride = Math.ceil(n / maxLabels);
  const xAt = type === "bar"
    ? (i) => x0 + (i + 0.5) * (plotW / n)
    : (i) => x0 + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  let out = "";
  labels.forEach((lab, i) => {
    if (i % stride !== 0) return;
    const text = xIndex >= 0 ? String(lab ?? "") : String(i + 1);
    const cx = xAt(i);
    out += `<text class="chart-axis-label" x="${cx.toFixed(1)}" y="${y0 + 16}" text-anchor="end" transform="rotate(-35 ${cx.toFixed(1)} ${y0 + 16})">${escSvg(text.length > 16 ? text.slice(0, 15) + "…" : text)}</text>`;
  });
  return out;
}

/* ------------------------------------------------------------- exports */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { toNumber, classifyColumns, inferChart, sameScaleGroup, niceTicks, scaleLinear, seriesColor, CHART_PALETTE };
}

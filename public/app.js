/* Warehouse Genie — vanilla SPA. Ports to Electron by loading this same
   bundle in a BrowserWindow pointed at the local server. */

const $ = (sel, root = document) => root.querySelector(sel);
const main = $("#main");

const state = {
  route: "chat",
  chat: { messages: [], conversationId: null, busy: false, streaming: null },
  pack: null,          // saved copy
  draft: null,         // editable copy
  dirty: false,
  packTab: "tables",
  health: null,
  diagnostics: { last: null, history: [] } // per-query inference metrics (session-scoped)
};

/* ───────────────────────────────────────────── utilities */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* Minimal, safe Markdown. The model emits a small subset (bold, italic, inline
   code, ordered/unordered lists, paragraphs) when it answers in prose. We
   ALWAYS esc() first so no model-supplied HTML survives, then wrap our own tags
   around the escaped text — never a dependency, never raw HTML injection. */
function mdInline(s) {
  // esc() first so no model HTML survives; then bold/italic, then inline code.
  // Order matters: table names in `code` contain underscores but never '*', so
  // running bold/italic before code can't corrupt them — no stashing needed.
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function renderMarkdown(src) {
  const lines = String(src ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  const isOl = (l) => /^\s*\d+\.\s+/.test(l);
  const isUl = (l) => /^\s*[-*]\s+/.test(l);
  const isH = (l) => /^#{1,3}\s+/.test(l);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }

    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { const lvl = Math.min(6, h[1].length + 3); out.push(`<h${lvl}>${mdInline(h[2])}</h${lvl}>`); i++; continue; }

    if (isOl(line)) {
      const items = [];
      while (i < lines.length && isOl(lines[i])) { items.push(`<li>${mdInline(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`); i++; }
      out.push(`<ol>${items.join("")}</ol>`); continue;
    }
    if (isUl(line)) {
      const items = [];
      while (i < lines.length && isUl(lines[i])) { items.push(`<li>${mdInline(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>`); i++; }
      out.push(`<ul>${items.join("")}</ul>`); continue;
    }

    const buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isOl(lines[i]) && !isUl(lines[i]) && !isH(lines[i])) {
      buf.push(lines[i]); i++;
    }
    out.push(`<p>${mdInline(buf.join(" "))}</p>`);
  }
  return out.join("");
}

function toast(msg, isErr = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (isErr ? " err" : "");
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 3200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const SQL_KEYWORDS = /\b(select|from|where|group by|order by|having|join|left join|right join|inner join|full join|cross join|on|as|with|union all|union|limit|distinct|case|when|then|else|end|and|or|not|in|is|null|like|between|desc|asc|over|partition by|qualify|insert|update|delete|create|drop)\b/gi;
const SQL_FUNCTIONS = /\b(sum|count|avg|min|max|round|coalesce|nullif|date_trunc|add_months|current_date|current_timestamp|cast|concat|lower|upper|row_number|rank|dense_rank|lag|lead|datediff|date_add|date_sub|to_date|year|month|day)\b(?=\s*\()/gi;

function highlightSql(sql) {
  let out = esc(sql);
  const stash = [];
  out = out
    .replace(/--[^\n]*/g, (m) => `\u0000${stash.push(`<span class="sql-cm">${m}</span>`) - 1}\u0000`)
    .replace(/&#39;(?:[^&]|&(?!#39;))*?&#39;/g, (m) => `\u0000${stash.push(`<span class="sql-str">${m}</span>`) - 1}\u0000`)
    .replace(SQL_FUNCTIONS, (m) => `\u0000${stash.push(`<span class="sql-fn">${m}</span>`) - 1}\u0000`)
    .replace(SQL_KEYWORDS, (m) => `\u0000${stash.push(`<span class="sql-kw">${m}</span>`) - 1}\u0000`)
    // Lookarounds keep this pass from matching the index digits inside the
    // \u0000<i>\u0000 placeholders left by the earlier passes.
    .replace(/(?<!\u0000)\b\d+(\.\d+)?\b(?!\u0000)/g, (m) => `\u0000${stash.push(`<span class="sql-num">${m}</span>`) - 1}\u0000`);
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i]);
}

/* ───────────────────────────────────────────── health */

async function pollHealth() {
  try {
    state.health = await api("/api/health");
  } catch {
    state.health = null;
  }
  for (const [key, id] of [["databricks", "#health-databricks"], ["ollama", "#health-ollama"]]) {
    const el = $(id);
    const h = state.health?.[key];
    el.classList.toggle("ok", Boolean(h?.ok));
    el.classList.toggle("bad", h ? !h.ok : false);
    const detail = $(".health-detail", el);
    detail.textContent = h?.detail || "checking…";
    detail.title = h?.detail || "";
  }
}

/* ───────────────────────────────────────────── chat view */

const SUGGESTIONS = [
  "What was total spend by platform last month?",
  "Top 10 campaigns by conversions this quarter",
  "How did clicks trend week over week for the Meta platform?"
];

function renderChat() {
  const { messages, busy } = state.chat;
  main.innerHTML = `
    <div class="chat">
      <div class="chat-scroll" id="chat-scroll">
        <div class="chat-inner" id="chat-inner">
          ${messages.length === 0 ? emptyStateHtml() : messages.map(msgHtml).join("")}
          ${state.chat.streaming
            ? streamingCardHtml(state.chat.streaming)
            : (busy ? `<div class="msg msg-agent"><div class="thinking"><span class="dot"></span>generating & executing…</div></div>` : "")}
        </div>
      </div>
      <div class="composer">
        <div class="composer-inner">
          <div class="composer-row">
            <textarea id="composer-input" placeholder="Ask a question about your data…" rows="1"></textarea>
            <button class="btn btn-primary" id="composer-send" ${busy ? "disabled" : ""}>Ask</button>
          </div>
          <div class="composer-hint">enter to send · shift+enter for newline · follow-ups keep context${messages.length ? ` · <a href="#" id="chat-reset" style="color:var(--faint)">new conversation</a>` : ""}</div>
        </div>
      </div>
    </div>`;

  const input = $("#composer-input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  $("#composer-send").addEventListener("click", sendMessage);
  $("#chat-reset")?.addEventListener("click", (e) => {
    e.preventDefault();
    api("/api/chat/reset", { method: "POST", body: { conversationId: state.chat.conversationId } }).catch(() => {});
    state.chat = { messages: [], conversationId: null, busy: false, streaming: null };
    renderChat();
  });
  document.querySelectorAll(".suggestion").forEach((b) =>
    b.addEventListener("click", () => { input.value = b.textContent; sendMessage(); }));
  document.querySelectorAll("[data-toggle-err]").forEach((chip) =>
    chip.addEventListener("click", () => {
      const detail = $(`[data-err-detail="${chip.dataset.toggleErr}"]`);
      if (detail) detail.hidden = !detail.hidden;
    }));
  document.querySelectorAll("[data-copy-sql]").forEach((btn) =>
    btn.addEventListener("click", () => {
      navigator.clipboard.writeText(btn.dataset.copySql).then(() => toast("SQL copied"));
    }));

  const scroll = $("#chat-scroll");
  scroll.scrollTop = scroll.scrollHeight;
  if (!busy) input.focus();
}

function emptyStateHtml() {
  return `
    <div class="empty-state">
      <div class="eyebrow">ask the warehouse</div>
      <h1>Questions in, governed SQL out.</h1>
      <p>Runs entirely on this machine: a local model writes Databricks SQL grounded in your team's context pack, executes it with your permissions, and shows every attempt it took.</p>
      <div class="suggestions">
        ${SUGGESTIONS.map((s) => `<button class="suggestion">${esc(s)}</button>`).join("")}
      </div>
    </div>`;
}

let msgSeq = 0;

function msgHtml(m) {
  if (m.role === "user") {
    return `<div class="msg msg-user"><div class="bubble">${esc(m.text)}</div></div>`;
  }
  if (m.error) {
    return `<div class="msg msg-agent"><div class="msg-error">⚠ ${esc(m.error)}</div></div>`;
  }
  if (m.kind === "text") {
    return `<div class="msg msg-agent"><div class="plain">${renderMarkdown(m.text)}</div></div>`;
  }
  return `<div class="msg msg-agent">
    ${m.summary ? `<p class="summary">${mdInline(m.summary)}</p>` : ""}
    ${thoughtsHtml(m.thinking)}
    ${statementCardHtml(m)}
    ${m.meta ? `<div class="grounding">grounded on <b>${m.meta.tablesUsed.length} table${m.meta.tablesUsed.length === 1 ? "" : "s"}</b> · <b>${m.meta.examplesUsed} example${m.meta.examplesUsed === 1 ? "" : "s"}</b> retrieved</div>` : ""}
  </div>`;
}

function statementCardHtml(m) {
  const id = ++msgSeq;
  const finalAttempt = m.attempts[m.attempts.length - 1];
  const succeeded = finalAttempt?.status === "succeeded";

  const trail = m.attempts.map((a, i) => {
    const isLast = i === m.attempts.length - 1;
    const chip = a.status === "succeeded"
      ? `<span class="trail-chip ok">✓ ran</span>`
      : a.status === "blocked"
        ? `<span class="trail-chip err">blocked</span>`
        : `<span class="trail-chip err" data-toggle-err="${id}-${i}" title="Show error">✗ attempt ${i + 1}</span>`;
    return chip + (isLast ? "" : `<span class="trail-arrow">→</span>`);
  }).join("");

  const errDetails = m.attempts
    .map((a, i) => a.error
      ? `<div class="stmt-error-detail" data-err-detail="${id}-${i}" hidden>${esc(a.error)}\n\n--- failing sql ---\n${esc(a.sql)}</div>`
      : "")
    .join("");

  return `<div class="stmt">
    <div class="stmt-trail">
      <span class="trail-chip">sql generated</span><span class="trail-arrow">→</span>
      ${trail}
      <span class="trail-meta">${m.attempts.length} attempt${m.attempts.length === 1 ? "" : "s"}</span>
    </div>
    ${errDetails}
    <pre class="stmt-sql">${highlightSql(finalAttempt?.sql || "")}</pre>
    ${succeeded && m.result ? resultTableHtml(m.result) : `<div class="stmt-error-detail" style="border-top:1px solid var(--line-soft)">Gave up after ${m.attempts.length} attempts. The last error is shown above — this usually means the context pack needs a better table description or example.</div>`}
    <div class="stmt-actions">
      <button class="btn btn-ghost btn-sm" data-copy-sql="${esc(finalAttempt?.sql || "")}">Copy SQL</button>
    </div>
  </div>`;
}

function resultTableHtml(r) {
  if (!r.rows.length) return `<div class="result-foot">Query succeeded — 0 rows returned.</div>`;
  return `
    <div class="result-wrap">
      <table class="result">
        <thead><tr>${r.columns.map((c) => `<th>${esc(c.name)}<span class="coltype">${esc(c.type)}</span></th>`).join("")}</tr></thead>
        <tbody>
          ${r.rows.map((row) => `<tr>${row.map((v) => `<td>${v === null ? '<span style="color:var(--faint)">null</span>' : esc(v)}</td>`).join("")}</tr>`).join("")}
        </tbody>
      </table>
    </div>
    <div class="result-foot">${r.rowCount} row${r.rowCount === 1 ? "" : "s"}${r.truncated ? " · truncated" : ""}</div>`;
}

const PHASE_LABEL = {
  generating: "generating…",
  executing: "running query…",
  summarizing: "summarizing…"
};

// While the model is generating we don't yet know if the answer is a SQL block
// or a plain-text reply (e.g. "what tables do you have?"). Guess from the first
// few characters. Prose while generating a SQL turn is the model's reasoning —
// it goes into a collapsed "thinking" disclosure, never a prominent block. The
// definitive `sql`/`text` events correct any wrong guess.
function classifyDraft(gen) {
  const t = gen.replace(/^\s+/, "");
  if (!t) return "draft";
  if (t.startsWith("```")) return "sql";
  if (/^(select|with|show|describe|desc|explain)\b/i.test(t)) return "sql";
  if (t.length >= 3) return "thinking";
  return "draft";
}

/** Drop fenced ```code``` blocks so the reasoning shown in the disclosure
 *  doesn't repeat the SQL that's already rendered in the statement card. */
function stripFencedSql(text) {
  return String(text || "").replace(/```[\s\S]*?```/g, "").trim();
}

/** Collapsed-by-default "Thinking" disclosure. Native <details> needs no JS
 *  binding and survives renderChat() re-renders. `open` renders it expanded
 *  (unused today — always collapsed). bodyId lets the live stream target it. */
function thoughtsHtml(reasoning, { bodyId = "" } = {}) {
  if (!reasoning) return "";
  return `<details class="thoughts">
    <summary>Thinking</summary>
    <div class="thoughts-body"${bodyId ? ` id="${bodyId}"` : ""}>${renderMarkdown(reasoning)}</div>
  </details>`;
}

function streamingCardHtml(s) {
  const status = `<div class="thinking" id="stream-status"><span class="dot"></span>${esc(s.status)}</div>`;

  if (s.mode === "sql") {
    return `<div class="msg msg-agent">
      <p class="summary" id="stream-summary" ${s.summary ? "" : "hidden"}>${mdInline(s.summary)}</p>
      ${thoughtsHtml(s.think)}
      <div class="stmt">
        <div class="stmt-trail" id="stream-trail">${liveTrailHtml(s.attempts)}</div>
        <pre class="stmt-sql" id="stream-gen" ${s.gen ? "" : "hidden"}>${esc(s.gen)}</pre>
        ${status}
      </div>
    </div>`;
  }

  if (s.mode === "text") {
    // a plain-text answer IS the answer — show it normally, never hidden
    return `<div class="msg msg-agent">
      <div class="plain" id="stream-gen" ${s.gen ? "" : "hidden"}>${renderMarkdown(s.gen)}</div>
      ${status}
    </div>`;
  }

  if (s.mode === "thinking") {
    // reasoning before SQL — collapsed by default so it doesn't flash prominently
    return `<div class="msg msg-agent">
      ${status}
      ${thoughtsHtml(s.gen, { bodyId: "stream-think" })}
    </div>`;
  }

  // draft — momentary, before we can tell SQL vs prose; show only the status
  return `<div class="msg msg-agent">${status}</div>`;
}

function liveTrailHtml(attempts) {
  let html = `<span class="trail-chip">sql generated</span>`;
  for (const a of attempts) {
    html += `<span class="trail-arrow">→</span>`;
    html += a.status === "succeeded" ? `<span class="trail-chip ok">✓ ran</span>`
      : a.status === "blocked" ? `<span class="trail-chip err">blocked</span>`
      : `<span class="trail-chip err">✗ failed</span>`;
  }
  return html;
}

/* live DOM updates that avoid re-rendering the whole chat on every token */
function setStreamGen(t) {
  const el = $("#stream-gen");
  if (el) {
    // SQL streams as raw monospace; prose/draft renders Markdown as it arrives.
    if (state.chat.streaming?.mode === "sql") el.textContent = t;
    else el.innerHTML = renderMarkdown(t);
    el.hidden = !t;
  }
  scrollChat();
}
function setStreamThink(t) { const el = $("#stream-think"); if (el) el.innerHTML = renderMarkdown(t); scrollChat(); }
function setStreamSummary(t) { const el = $("#stream-summary"); if (el) { el.innerHTML = mdInline(t); el.hidden = !t; } scrollChat(); }
function setStreamStatus(t) { const el = $("#stream-status"); if (el) el.innerHTML = `<span class="dot"></span>${esc(t)}`; }
function setStreamTrail(a) { const el = $("#stream-trail"); if (el) el.innerHTML = liveTrailHtml(a); }
function scrollChat() { const s = $("#chat-scroll"); if (s) s.scrollTop = s.scrollHeight; }

/** Apply one stream event. Returns true when the turn is finished.
 *  Structural changes (mode switch, finalized SQL, new attempt) re-render the
 *  card; token appends update the relevant node in place to stay smooth. */
function handleStreamEvent(evt, s) {
  switch (evt.type) {
    case "meta":
      if (evt.conversationId) state.chat.conversationId = evt.conversationId;
      return false;
    case "phase":
      s.status = PHASE_LABEL[evt.phase] || "working…";
      if (evt.phase === "generating") { s.gen = ""; s.mode = "draft"; renderChat(); } // reset per generation
      else setStreamStatus(s.status);
      return false;
    case "gen_token":
      s.gen += evt.text;
      if (s.mode === "draft") {
        const m = classifyDraft(s.gen);
        if (m !== "draft") { s.mode = m; renderChat(); return false; } // structure changed
      }
      if (s.mode === "thinking") setStreamThink(s.gen);
      else setStreamGen(s.gen);
      return false;
    case "sql":
      s.think = stripFencedSql(s.gen); // keep the reasoning for the collapsed dropdown
      s.gen = evt.sql;                 // swap the raw token stream for the clean SQL
      s.mode = "sql";
      renderChat();
      return false;
    case "attempt":
      s.attempts.push(evt.attempt);
      s.mode = "sql";
      renderChat();
      return false;
    case "result":
      s.status = "rendering results…";
      setStreamStatus(s.status);
      return false;
    case "summary_token":
      s.summary += evt.text;
      setStreamSummary(s.summary);
      return false;
    case "text":
      s.gen = evt.text;              // plain-text answer renders as prose, not a SQL card
      s.mode = "text";
      renderChat();
      return false;
    case "done": {
      const { type, conversationId, ...msg } = evt;
      if (conversationId) state.chat.conversationId = conversationId;
      // Carry the captured reasoning onto the finished SQL answer (text answers
      // have no reasoning to keep — the prose there was the answer itself).
      const thinking = msg.kind === "sql" ? s.think : "";
      state.chat.messages.push({ role: "agent", ...msg, thinking });
      if (msg.stats) {
        state.diagnostics.last = msg.stats;
        state.diagnostics.history.push(msg.stats);
        if (state.diagnostics.history.length > 50) state.diagnostics.history.shift();
      }
      endStream();
      return true;
    }
    case "error":
      state.chat.messages.push({ role: "agent", error: evt.error });
      endStream();
      return true;
  }
  return false;
}

function endStream() {
  state.chat.busy = false;
  state.chat.streaming = null;
  renderChat();
}

async function sendMessage() {
  const input = $("#composer-input");
  const text = input.value.trim();
  if (!text || state.chat.busy) return;

  state.chat.messages.push({ role: "user", text });
  state.chat.busy = true;
  state.chat.streaming = { status: "generating…", mode: "draft", gen: "", think: "", summary: "", attempts: [] };
  renderChat();

  const s = state.chat.streaming;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, conversationId: state.chat.conversationId })
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (handleStreamEvent(evt, s)) { finished = true; break; }
      }
    }
    // Stream closed without a terminal event (e.g. server crash) — recover.
    if (!finished && state.chat.streaming) {
      state.chat.messages.push({ role: "agent", error: "The response ended unexpectedly." });
      endStream();
    }
  } catch (e) {
    state.chat.messages.push({ role: "agent", error: e.message });
    endStream();
  }
}

/* ───────────────────────────────────────────── pack editor */

async function loadPack() {
  state.pack = await api("/api/pack");
  state.draft = structuredClone(state.pack);
  state.dirty = false;
}

function markDirty() {
  state.dirty = true;
  const note = $("#dirty-note");
  if (note) note.textContent = "unsaved changes";
}

function renderPack() {
  const d = state.draft;
  if (!d) { main.innerHTML = `<div class="pack"><div class="pack-inner">Loading…</div></div>`; return; }

  main.innerHTML = `
    <div class="pack">
      <div class="pack-inner">
        <div class="pack-head">
          <div>
            <div class="eyebrow">context pack · the genie space</div>
            <h1>${esc(d.name)}</h1>
            <div class="meta">${d.updated_at ? `updated ${new Date(d.updated_at).toLocaleString()}` : "not yet saved"}</div>
          </div>
          <div class="spacer"></div>
          <span class="version-badge">v${d.version}</span>
          <button class="btn btn-sm" id="btn-export">Export</button>
          <button class="btn btn-sm" id="btn-import">Import</button>
        </div>

        <div class="tabs">
          ${["tables", "examples", "instructions", "relationships", "preview"].map((t) =>
            `<button class="tab ${state.packTab === t ? "active" : ""}" data-tab="${t}">${t}</button>`).join("")}
        </div>

        <div id="tab-body">${packTabHtml(d)}</div>

        <div class="save-bar">
          <button class="btn btn-primary" id="btn-save-pack">Save pack (v${d.version} → v${d.version + 1})</button>
          <span class="dirty-note" id="dirty-note">${state.dirty ? "unsaved changes" : ""}</span>
        </div>
      </div>
    </div>`;

  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => { state.packTab = t.dataset.tab; renderPack(); }));
  $("#btn-save-pack").addEventListener("click", savePack);
  $("#btn-export").addEventListener("click", () => { window.location.href = "/api/pack/export"; });
  $("#btn-import").addEventListener("click", importPack);
  bindPackTab();
}

function packTabHtml(d) {
  switch (state.packTab) {
    case "instructions":
      return `
        <p class="hint">Business rules the model should always follow — fiscal calendars, metric definitions, naming taxonomies, default filters. This is injected into every prompt.</p>
        <textarea id="f-instructions" rows="10">${esc(d.instructions)}</textarea>
        <label>Pack name</label>
        <input type="text" id="f-name" value="${esc(d.name)}" />`;

    case "tables":
      return `
        <div class="card">
          <div class="eyebrow" style="margin-bottom:10px">sync from databricks</div>
          <div class="grid-2">
            <div><label>Catalog</label><input type="text" id="sync-catalog" placeholder="main" class="mono" /></div>
            <div><label>Schema</label><input type="text" id="sync-schema" placeholder="gold" class="mono" /></div>
          </div>
          <label>Tables (optional, comma-separated — blank = all)</label>
          <input type="text" id="sync-tables" placeholder="campaign_performance_daily, campaigns" class="mono" />
          <div class="actions-row">
            <button class="btn" id="btn-sync">Pull table metadata</button>
          </div>
          <p class="hint" style="margin-bottom:0">Pulls columns, types, and comments from information_schema. Your descriptions and synonyms are preserved on re-sync.</p>
        </div>
        ${d.tables.length === 0 ? `<p class="hint">No tables yet. Sync a schema above — this is what the model is allowed to query.</p>` : ""}
        ${d.tables.map((t, i) => `
          <div class="card">
            <div class="card-row">
              <div>
                <div class="card-title">${esc(t.full_name)}</div>
                <div class="card-sub">${t.columns.length} columns</div>
              </div>
              <div class="spacer"></div>
              <button class="btn btn-ghost btn-sm" data-toggle-cols="${i}">Columns</button>
              <button class="btn btn-ghost btn-sm btn-danger" data-del-table="${i}">Remove</button>
            </div>
            <label>Description — what is this table, at what grain?</label>
            <textarea data-table-desc="${i}" rows="2">${esc(t.description)}</textarea>
            <label>Synonyms — what do stakeholders call this?</label>
            <input type="text" data-table-syn="${i}" value="${esc((t.synonyms || []).join(", "))}" placeholder="media performance, ad spend" />
            <div class="cols" data-cols="${i}" hidden>
              ${t.columns.map((c) => `<div class="col-line"><span class="col-name">${esc(c.name)}</span><span class="col-type">${esc(c.type)}</span><span class="col-comment">${esc(c.comment || "—")}</span></div>`).join("")}
            </div>
          </div>`).join("")}`;

    case "examples":
      return `
        <p class="hint">Trusted question → SQL pairs. The agent retrieves the most similar ones per question and uses them as few-shot examples — the single biggest quality lever you have.</p>
        <button class="btn" id="btn-add-example">Add example</button>
        ${d.examples.map((ex, i) => `
          <div class="card" style="margin-top:12px">
            <div class="card-row">
              <div class="card-sub" style="margin:0; color:var(--text)">${esc(ex.question)}</div>
              <div class="spacer"></div>
              <button class="btn btn-ghost btn-sm" data-edit-example="${i}">Edit</button>
              <button class="btn btn-ghost btn-sm btn-danger" data-del-example="${i}">Remove</button>
            </div>
            <pre class="stmt-sql" style="padding:10px 0 0">${highlightSql(ex.sql)}</pre>
            ${ex.notes ? `<div class="hint" style="margin:8px 0 0">${esc(ex.notes)}</div>` : ""}
          </div>`).join("")}`;

    case "relationships":
      return `
        <p class="hint">Join hints in plain language, e.g. "fact.campaign_id joins to dim_campaigns.campaign_id (many-to-one)".</p>
        <button class="btn" id="btn-add-rel">Add relationship</button>
        ${d.relationships.map((r, i) => `
          <div class="card" style="margin-top:12px">
            <div class="card-row">
              <input type="text" data-rel="${i}" value="${esc(r.description)}" class="mono" />
              <button class="btn btn-ghost btn-sm btn-danger" data-del-rel="${i}">✕</button>
            </div>
          </div>`).join("")}`;

    case "preview":
      return `
        <p class="hint">Type a question to see the exact system prompt the agent will build — which tables and examples get retrieved. Save the pack first to preview unsaved edits.</p>
        <div class="card-row">
          <input type="text" id="preview-q" placeholder="What was spend by platform last month?" />
          <button class="btn" id="btn-preview">Build prompt</button>
        </div>
        <pre class="stmt-sql" id="preview-out" style="margin-top:14px; white-space:pre-wrap; border:1px solid var(--line-soft); border-radius:10px; background:var(--surface)"></pre>`;
  }
}

function bindPackTab() {
  const d = state.draft;

  $("#f-instructions")?.addEventListener("input", (e) => { d.instructions = e.target.value; markDirty(); });
  $("#f-name")?.addEventListener("input", (e) => { d.name = e.target.value; markDirty(); });

  $("#btn-sync")?.addEventListener("click", async () => {
    const catalog = $("#sync-catalog").value.trim();
    const schema = $("#sync-schema").value.trim();
    const tables = $("#sync-tables").value.split(",").map((s) => s.trim()).filter(Boolean);
    if (!catalog || !schema) return toast("Catalog and schema are required", true);
    const btn = $("#btn-sync");
    btn.disabled = true; btn.textContent = "Syncing…";
    try {
      const res = await api("/api/pack/sync-tables", { method: "POST", body: { catalog, schema, tables: tables.length ? tables : undefined } });
      state.pack = res.pack;
      state.draft = structuredClone(res.pack);
      state.dirty = false;
      toast(`Synced ${res.syncedCount} tables (pack is now v${res.pack.version})`);
      renderPack();
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false; btn.textContent = "Pull table metadata";
    }
  });

  document.querySelectorAll("[data-toggle-cols]").forEach((b) =>
    b.addEventListener("click", () => {
      const cols = $(`[data-cols="${b.dataset.toggleCols}"]`);
      cols.hidden = !cols.hidden;
    }));
  document.querySelectorAll("[data-del-table]").forEach((b) =>
    b.addEventListener("click", () => { d.tables.splice(+b.dataset.delTable, 1); markDirty(); renderPack(); }));
  document.querySelectorAll("[data-table-desc]").forEach((el) =>
    el.addEventListener("input", () => { d.tables[+el.dataset.tableDesc].description = el.value; markDirty(); }));
  document.querySelectorAll("[data-table-syn]").forEach((el) =>
    el.addEventListener("input", () => {
      d.tables[+el.dataset.tableSyn].synonyms = el.value.split(",").map((s) => s.trim()).filter(Boolean);
      markDirty();
    }));

  $("#btn-add-example")?.addEventListener("click", () => exampleModal(null));
  document.querySelectorAll("[data-edit-example]").forEach((b) =>
    b.addEventListener("click", () => exampleModal(+b.dataset.editExample)));
  document.querySelectorAll("[data-del-example]").forEach((b) =>
    b.addEventListener("click", () => { d.examples.splice(+b.dataset.delExample, 1); markDirty(); renderPack(); }));

  $("#btn-add-rel")?.addEventListener("click", () => { d.relationships.push({ description: "" }); markDirty(); renderPack(); });
  document.querySelectorAll("[data-rel]").forEach((el) =>
    el.addEventListener("input", () => { d.relationships[+el.dataset.rel].description = el.value; markDirty(); }));
  document.querySelectorAll("[data-del-rel]").forEach((b) =>
    b.addEventListener("click", () => { d.relationships.splice(+b.dataset.delRel, 1); markDirty(); renderPack(); }));

  $("#btn-preview")?.addEventListener("click", async () => {
    const q = $("#preview-q").value.trim();
    if (!q) return;
    const res = await api("/api/prompt-preview", { method: "POST", body: { question: q } });
    $("#preview-out").textContent = res.prompt;
  });
}

async function savePack() {
  try {
    state.pack = await api("/api/pack", { method: "PUT", body: state.draft });
    state.draft = structuredClone(state.pack);
    state.dirty = false;
    toast(`Saved — pack is now v${state.pack.version}`);
    renderPack();
  } catch (e) {
    toast(e.message, true);
  }
}

function importPack() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json";
  input.onchange = async () => {
    try {
      const text = await input.files[0].text();
      const pack = JSON.parse(text);
      state.pack = await api("/api/pack", { method: "PUT", body: pack });
      state.draft = structuredClone(state.pack);
      state.dirty = false;
      toast(`Imported "${state.pack.name}" (now v${state.pack.version})`);
      renderPack();
    } catch (e) {
      toast(`Import failed: ${e.message}`, true);
    }
  };
  input.click();
}

/* ───────────────────────────────────────────── example modal */

function openModal(html) {
  $("#modal").innerHTML = html;
  $("#modal-backdrop").hidden = false;
}
function closeModal() { $("#modal-backdrop").hidden = true; }
$("#modal-backdrop").addEventListener("click", (e) => {
  if (e.target === $("#modal-backdrop")) closeModal();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

function exampleModal(index) {
  const ex = index !== null ? state.draft.examples[index] : { question: "", sql: "", notes: "" };
  openModal(`
    <h2>${index !== null ? "Edit" : "Add"} example query</h2>
    <div class="modal-sub">A trusted question → SQL pair the model can imitate.</div>
    <label>Question, as a stakeholder would ask it</label>
    <input type="text" id="ex-q" value="${esc(ex.question)}" />
    <label>SQL (validated — run it in Databricks first)</label>
    <textarea id="ex-sql" class="mono" rows="9">${esc(ex.sql)}</textarea>
    <label>Notes for the model (optional)</label>
    <input type="text" id="ex-notes" value="${esc(ex.notes || "")}" />
    <div class="modal-actions">
      <button class="btn btn-ghost" id="ex-cancel">Cancel</button>
      <button class="btn btn-primary" id="ex-save">${index !== null ? "Update" : "Add"} example</button>
    </div>`);
  $("#ex-cancel").addEventListener("click", closeModal);
  $("#ex-save").addEventListener("click", () => {
    const next = {
      question: $("#ex-q").value.trim(),
      sql: $("#ex-sql").value.trim(),
      notes: $("#ex-notes").value.trim()
    };
    if (!next.question || !next.sql) return toast("Question and SQL are both required", true);
    if (index !== null) state.draft.examples[index] = next;
    else state.draft.examples.push(next);
    markDirty();
    closeModal();
    renderPack();
  });
}

/* ───────────────────────────────────────────── settings modal */

/** Inference metrics for admins — last query + session average. Reads
 *  session-scoped client state; the server terminal log is the durable record. */
function diagnosticsHtml() {
  const { last, history } = state.diagnostics;
  if (!last) {
    return `<div class="hint" style="margin:0">No queries yet this session — ask something, then reopen Settings.</div>`;
  }
  // Session average tok/s = total generated tokens / total generation seconds.
  const totGen = history.reduce((a, s) => a + (s.genTokens || 0), 0);
  const totSec = history.reduce((a, s) => a + (s.genSeconds || 0), 0);
  const avg = totSec ? (totGen / totSec).toFixed(1) : "n/a";
  const rate = last.genTokPerSec != null ? `${last.genTokPerSec}` : "n/a";
  return `
    <div class="diag">
      <div class="diag-row"><span>Last query</span><b>${rate} tok/s</b></div>
      <div class="diag-sub">${last.genTokens} generated · ${last.promptTokens} prompt tokens · ${last.llmCalls} model call${last.llmCalls === 1 ? "" : "s"}</div>
      <div class="diag-sub">${last.wallSeconds}s total · ${last.totalModelSeconds}s model${last.loadSeconds ? ` · ${last.loadSeconds}s load` : ""} · ${esc(last.model)}</div>
      <div class="diag-row" style="margin-top:8px"><span>Session (${history.length} quer${history.length === 1 ? "y" : "ies"})</span><b>${avg} tok/s avg</b></div>
    </div>`;
}

/** Fill the model <select> with the models installed in the configured Ollama.
 *  `preselect` (the saved model) wins on first open; afterwards we keep whatever
 *  is currently chosen. The saved/chosen model is always kept as an option even
 *  if it isn't installed (or Ollama is down), so Save never loses it. */
async function refreshModels(preselect) {
  const sel = $("#s-model");
  const status = $("#s-model-status");
  if (!sel) return;
  const want = (preselect ?? sel.value ?? "").trim();
  const url = $("#s-ollama")?.value.trim();

  status.textContent = "Loading models…";
  let data;
  try {
    data = await api("/api/ollama/models" + (url ? `?url=${encodeURIComponent(url)}` : ""));
  } catch {
    data = { ok: false, models: [] };
  }

  const models = data.models || [];
  // Same readiness rule as the server health check: exact, else a tag of the family.
  const matches = (m) => m === want || (want && m.startsWith(want + ":"));
  const installedMatch = models.find((m) => m === want) || models.find((m) => matches(m));
  const options = [...models];
  if (want && !installedMatch) options.unshift(want); // keep the current setting selectable
  const selectedVal = installedMatch || want || options[0] || "";

  sel.innerHTML = options.map((m) => {
    const label = (m === want && !installedMatch) ? `${m} (not installed)` : m;
    return `<option value="${esc(m)}" ${m === selectedVal ? "selected" : ""}>${esc(label)}</option>`;
  }).join("");

  status.textContent = data.ok
    ? `${models.length} model${models.length === 1 ? "" : "s"} installed`
    : "Ollama not reachable — start it and click ↻";
}

async function settingsModal() {
  const s = await api("/api/settings");
  openModal(`
    <h2>Settings</h2>
    <div class="modal-sub">Stored locally in config.json — nothing leaves this machine except calls to your own Databricks workspace.</div>
    <label>Databricks workspace URL</label>
    <input type="text" id="s-host" value="${esc(s.databricksHost)}" placeholder="https://dbc-xxxx.cloud.databricks.com" class="mono" />
    <label>Personal access token ${s.hasToken ? "(saved — leave to keep)" : ""}</label>
    <input type="password" id="s-token" value="${esc(s.databricksToken)}" placeholder="dapi…" class="mono" />
    <label>SQL warehouse ID</label>
    <input type="text" id="s-wh" value="${esc(s.warehouseId)}" placeholder="abc123def456" class="mono" />
    <label>Ollama URL</label>
    <input type="text" id="s-ollama" value="${esc(s.ollamaUrl)}" class="mono" />
    <label>Model</label>
    <div style="display:flex; gap:8px; align-items:center">
      <select id="s-model" class="mono"></select>
      <button class="btn btn-sm" id="s-model-refresh" type="button" title="Reload installed models">↻</button>
    </div>
    <div class="hint" id="s-model-status" style="margin-top:6px">Loading models…</div>

    <div class="diag-head">Diagnostics <span class="diag-tag">inference speed</span></div>
    ${diagnosticsHtml()}

    <div class="modal-actions">
      <button class="btn btn-ghost" id="s-cancel">Cancel</button>
      <button class="btn btn-primary" id="s-save">Save & test</button>
    </div>`);

  // Populate the model dropdown from the user's Ollama; refresh on demand or
  // when the URL changes.
  refreshModels(s.ollamaModel);
  $("#s-model-refresh").addEventListener("click", () => refreshModels());
  $("#s-ollama").addEventListener("change", () => refreshModels());

  $("#s-cancel").addEventListener("click", closeModal);
  $("#s-save").addEventListener("click", async () => {
    await api("/api/settings", {
      method: "PUT",
      body: {
        databricksHost: $("#s-host").value.trim(),
        databricksToken: $("#s-token").value.trim(),
        warehouseId: $("#s-wh").value.trim(),
        ollamaUrl: $("#s-ollama").value.trim(),
        ollamaModel: $("#s-model").value.trim()
      }
    });
    closeModal();
    toast("Settings saved — testing connections…");
    await pollHealth();
    const h = state.health;
    if (h?.databricks?.ok && h?.ollama?.ok) toast("Connected to Databricks and Ollama ✓");
    else toast(`${!h?.databricks?.ok ? "Databricks: " + (h?.databricks?.detail || "failed") : ""} ${!h?.ollama?.ok ? "· Ollama: " + (h?.ollama?.detail || "failed") : ""}`.trim(), true);
  });
}

$("#btn-settings").addEventListener("click", settingsModal);

/* ───────────────────────────────────────────── router */

async function route() {
  const hash = location.hash.replace("#/", "") || "chat";
  state.route = ["chat", "pack"].includes(hash) ? hash : "chat";
  document.querySelectorAll(".nav-item").forEach((a) =>
    a.classList.toggle("active", a.dataset.route === state.route));
  if (state.route === "pack") {
    if (!state.draft) await loadPack().catch((e) => toast(e.message, true));
    renderPack();
  } else {
    renderChat();
  }
}

window.addEventListener("hashchange", route);

/* ───────────────────────────────────────────── boot */

route();
pollHealth();
setInterval(pollHealth, 30_000);

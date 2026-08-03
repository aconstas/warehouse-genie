/* Warehouse Genie — vanilla SPA. Ports to Electron by loading this same
   bundle in a BrowserWindow pointed at the local server. */

const $ = (sel, root = document) => root.querySelector(sel);
const main = $("#main");

const state = {
  route: "chat",
  chat: { messages: [], conversationId: null, busy: false },
  pack: null,          // saved copy
  draft: null,         // editable copy
  dirty: false,
  packTab: "tables",
  health: null
};

/* ───────────────────────────────────────────── utilities */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
          ${busy ? `<div class="msg msg-agent"><div class="thinking"><span class="dot"></span>generating & executing…</div></div>` : ""}
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
    state.chat = { messages: [], conversationId: null, busy: false };
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
    return `<div class="msg msg-agent"><div class="plain">${esc(m.text)}</div></div>`;
  }
  return `<div class="msg msg-agent">
    ${m.summary ? `<p class="summary">${esc(m.summary)}</p>` : ""}
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

async function sendMessage() {
  const input = $("#composer-input");
  const text = input.value.trim();
  if (!text || state.chat.busy) return;

  state.chat.messages.push({ role: "user", text });
  state.chat.busy = true;
  renderChat();

  try {
    const res = await api("/api/chat", {
      method: "POST",
      body: { message: text, conversationId: state.chat.conversationId }
    });
    state.chat.conversationId = res.conversationId;
    state.chat.messages.push({ role: "agent", ...res });
  } catch (e) {
    state.chat.messages.push({ role: "agent", error: e.message });
  } finally {
    state.chat.busy = false;
    renderChat();
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
    <input type="text" id="s-model" value="${esc(s.ollamaModel)}" placeholder="qwen3:14b" class="mono" />
    <div class="modal-actions">
      <button class="btn btn-ghost" id="s-cancel">Cancel</button>
      <button class="btn btn-primary" id="s-save">Save & test</button>
    </div>`);
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

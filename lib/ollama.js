/** Minimal Ollama client (non-streaming for MVP simplicity). */

async function chat(cfg, messages, { temperature = 0.1 } = {}) {
  let res;
  try {
    res = await fetch(`${cfg.ollamaUrl.replace(/\/+$/, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.ollamaModel,
      messages,
      stream: false,
      // Thinking output is stripped anyway; disabling it saves hundreds of
      // tokens per response — critical on CPU-only machines (~3 tok/s).
      think: false,
      keep_alive: "30m",
      options: { temperature, num_ctx: 8192 }
    })
    });
  } catch (e) {
    throw new Error(`Could not reach Ollama at ${cfg.ollamaUrl} — is it running? (ollama serve)`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  let content = data.message?.content || "";
  // Qwen3 thinking models wrap reasoning in <think> tags — strip before parsing
  content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return content;
}

async function health(cfg) {
  try {
    const res = await fetch(`${cfg.ollamaUrl.replace(/\/+$/, "")}/api/tags`);
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    const hasModel = models.some((m) => m === cfg.ollamaModel || m.startsWith(cfg.ollamaModel + ":"));
    return {
      ok: true,
      detail: hasModel ? cfg.ollamaModel : `${cfg.ollamaModel} not pulled (${models.length} models available)`,
      modelReady: hasModel,
      models
    };
  } catch (e) {
    return { ok: false, detail: "Ollama not reachable — is it running?" };
  }
}

module.exports = { chat, health };

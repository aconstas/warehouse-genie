/** Minimal Ollama client. */

const THINK_BLOCK = /<think>[\s\S]*?<\/think>/g;

/**
 * Streaming chat. Ollama returns one JSON object per line; we forward each
 * content delta to onToken(text) as it arrives and resolve to the full
 * (think-stripped) content once the stream ends. Pass onToken = null to consume
 * the stream without live output (see chat()).
 */
async function chatStream(cfg, messages, { temperature = 0.1 } = {}, onToken = null) {
  let res;
  try {
    res = await fetch(`${cfg.ollamaUrl.replace(/\/+$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.ollamaModel,
        messages,
        stream: true,
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

  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.error) throw new Error(`Ollama error: ${obj.error}`);
      const delta = obj.message?.content || "";
      if (delta) {
        full += delta;
        // With think:false there are no <think> tokens to leak, so streaming
        // deltas straight through is safe; we still strip any complete block
        // from the final string as a belt-and-suspenders guard.
        if (onToken) onToken(delta);
      }
      if (obj.done) return full.replace(THINK_BLOCK, "").trim();
    }
  }
  return full.replace(THINK_BLOCK, "").trim();
}

/** Non-streaming convenience: run the stream to completion and return the text. */
async function chat(cfg, messages, opts = {}) {
  return chatStream(cfg, messages, opts, null);
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

module.exports = { chat, chatStream, health };

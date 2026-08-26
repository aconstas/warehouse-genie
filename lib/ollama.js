/** Minimal Ollama client. */

const THINK_BLOCK = /<think>[\s\S]*?<\/think>/g;

const baseUrl = (cfg) => cfg.ollamaUrl.replace(/\/+$/, "");

/**
 * Streaming chat. Ollama returns one JSON object per line; we forward each
 * content delta to onToken(text) as it arrives and resolve to the full
 * (think-stripped) content once the stream ends. Pass onToken = null to consume
 * the stream without live output (see chat()).
 *
 * onStats(metrics) fires once with the final chunk's timing/token counts
 * (durations in nanoseconds) so callers can report inference speed.
 */
async function chatStream(cfg, messages, { temperature = 0.1, onStats = null } = {}, onToken = null) {
  let res;
  try {
    res = await fetch(`${baseUrl(cfg)}/api/chat`, {
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
      if (obj.done) {
        if (onStats) onStats({
          model: obj.model,
          total_duration: obj.total_duration,
          load_duration: obj.load_duration,
          prompt_eval_count: obj.prompt_eval_count,
          prompt_eval_duration: obj.prompt_eval_duration,
          eval_count: obj.eval_count,
          eval_duration: obj.eval_duration
        });
        return full.replace(THINK_BLOCK, "").trim();
      }
    }
  }
  return full.replace(THINK_BLOCK, "").trim();
}

/** Non-streaming convenience: run the stream to completion and return the text. */
async function chat(cfg, messages, opts = {}) {
  return chatStream(cfg, messages, opts, null);
}

/**
 * Embed one string or a batch of them. Returns number[][] in input order —
 * always an array of vectors, even for a single string, so callers don't branch.
 * Used by lib/embeddings.js for both pack indexing and per-question queries.
 */
async function embed(cfg, inputs, { model, keepAlive = "30m" } = {}) {
  const input = Array.isArray(inputs) ? inputs : [inputs];
  if (!input.length) return [];
  let res;
  try {
    res = await fetch(`${baseUrl(cfg)}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: model || cfg.embeddingModel, input, keep_alive: keepAlive })
    });
  } catch (e) {
    throw new Error(`Could not reach Ollama at ${cfg.ollamaUrl} — is it running? (ollama serve)`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(`Ollama error: ${data.error}`);
  const vectors = data.embeddings || [];
  if (vectors.length !== input.length) {
    throw new Error(`Ollama returned ${vectors.length} embeddings for ${input.length} inputs`);
  }
  return vectors;
}

/** List installed model names (sorted). Throws if Ollama is unreachable so the
 *  caller can tell "no models" apart from "can't connect". */
async function listModels(cfg) {
  const res = await fetch(`${baseUrl(cfg)}/api/tags`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.models || []).map((m) => m.name).sort((a, b) => a.localeCompare(b));
}

async function health(cfg) {
  try {
    const res = await fetch(`${baseUrl(cfg)}/api/tags`);
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    const installed = (want) => Boolean(want) && models.some((m) => m === want || m.startsWith(want + ":"));
    const hasModel = installed(cfg.ollamaModel);
    // Without this, a user who never ran `ollama pull nomic-embed-text` gets
    // lexical-only retrieval forever with nothing in the UI saying why.
    const hasEmbedModel = installed(cfg.embeddingModel);
    return {
      ok: true,
      detail: hasModel ? cfg.ollamaModel : `${cfg.ollamaModel} not pulled (${models.length} models available)`,
      modelReady: hasModel,
      embeddingModel: cfg.embeddingModel,
      embeddingModelReady: hasEmbedModel,
      models
    };
  } catch (e) {
    return { ok: false, detail: "Ollama not reachable — is it running?" };
  }
}

module.exports = { chat, chatStream, embed, health, listModels };

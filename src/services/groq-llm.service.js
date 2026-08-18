'use strict';

/**
 * Groq Chat Completions wrapper.
 *
 * Used by the 3-tier LLM router for Tier 1 (openai/gpt-oss-20b) and Tier 2
 * (openai/gpt-oss-120b), plus the Tier 2 fallback (qwen/qwen3.6-27b) and the
 * micro-LLM classifier (openai/gpt-oss-20b).
 *
 * Groq's Chat Completions API is OpenAI-compatible, so we POST JSON to
 *   https://api.groq.com/openai/v1/chat/completions
 * with streaming enabled for live chunks.
 *
 * ---------------------------------------------------------------------------
 * REASONING MODELS — why this file is more than a thin fetch wrapper
 * ---------------------------------------------------------------------------
 * gpt-oss-20b / gpt-oss-120b / qwen3.6-27b are REASONING models. They emit
 * their chain-of-thought first, in a separate `delta.reasoning` field, and only
 * then the user-visible `delta.content`. Two consequences:
 *
 *   1. Reasoning tokens are billed against the SAME completion budget. With a
 *      small cap (Tier 1 used 256) the model spends the whole budget thinking,
 *      the stream ends with finish_reason="length", and `content` is EMPTY.
 *      The UI then renders a blank bubble marked "Complete" — the app looks
 *      dead even though the API call succeeded.
 *   2. Reading only `delta.content` silently discards everything else, so
 *      there is no diagnostic to explain the blank answer.
 *
 * Fixes applied here:
 *   - reasoning is suppressed at the API level (`reasoning_effort: 'low'` +
 *     `include_reasoning: false` for gpt-oss, `reasoning_format: 'hidden'` for
 *     qwen), so the budget goes to the answer;
 *   - a minimum completion budget is enforced for reasoning models;
 *   - `max_completion_tokens` replaces the deprecated `max_tokens`;
 *   - reasoning deltas are captured for diagnostics (never shown);
 *   - harmony control tokens (<|channel|>, <|return|>, …) and stray <think>
 *     blocks are stripped from streamed content;
 *   - an empty completion triggers ONE non-streaming retry with a bigger
 *     budget, and then throws a tagged error so the router fails over to the
 *     next model instead of returning silence.
 */

const { GROQ } = require('../shared/constants');
const { config } = require('../core/config-store');
const { createLogger } = require('../shared/logger');

const log = createLogger('groq-llm');

const GROQ_CHAT_ENDPOINT = `${GROQ.apiBase}${GROQ.chatEndpoint}`;

// Reasoning models burn completion tokens on hidden thinking before they emit
// a single visible character. Never give them less than this, whatever the
// tier asks for, or the answer gets truncated to nothing.
const REASONING_MIN_BUDGET = 1024;
// Budget used for the rescue retry when a completion came back empty.
const EMPTY_RETRY_BUDGET = 2048;

// All in-flight Groq chat requests, so the app can hard-stop them instantly
// (Stop button / Ctrl+Shift+K) — not just Gemini calls.
const activeControllers = new Set();
function cancelActive() {
  for (const controller of activeControllers) {
    try { controller.abort(); } catch (_) { /* ignore */ }
  }
  activeControllers.clear();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGptOss(model) { return /gpt-oss/i.test(String(model || '')); }
function isQwenReasoner(model) { return /qwen/i.test(String(model || '')); }
function isReasoningModel(model) {
  return isGptOss(model) || isQwenReasoner(model) || /deepseek-r1|reasoner/i.test(String(model || ''));
}

/**
 * Provider flags that keep the completion budget on the ANSWER.
 * gpt-oss does not support `reasoning_format`; qwen does not support
 * `include_reasoning`. The two fields are mutually exclusive on Groq.
 */
function reasoningParams(model) {
  if (isGptOss(model)) return { reasoning_effort: 'low', include_reasoning: false };
  if (isQwenReasoner(model)) return { reasoning_format: 'hidden', reasoning_effort: 'none' };
  return {};
}

/**
 * Streaming-safe scrubber for harmony control tokens and <think> blocks that
 * occasionally leak into `content`. Holds back a trailing partial token so a
 * marker split across two SSE chunks is still removed.
 */
function createContentFilter() {
  let carry = '';
  let inThink = false;

  const scrub = (input) => {
    let out = '';
    let rest = input;
    while (rest) {
      if (inThink) {
        const close = rest.indexOf('</think>');
        if (close === -1) return out; // still thinking — drop the rest
        rest = rest.slice(close + 8);
        inThink = false;
        continue;
      }
      const open = rest.indexOf('<think>');
      if (open === -1) { out += rest; break; }
      out += rest.slice(0, open);
      rest = rest.slice(open + 7);
      inThink = true;
    }
    return out.replace(/<\|[^|]*\|>/g, '');
  };

  return {
    /** Feed a delta, get back the safe-to-display portion. */
    push(delta) {
      const buffer = carry + String(delta || '');
      // A '<' near the end may be the start of a marker split across chunks.
      const cut = Math.max(buffer.lastIndexOf('<|'), buffer.lastIndexOf('<think'), buffer.lastIndexOf('</think'));
      if (cut !== -1 && !/\|>$|<\/think>$|<think>$/.test(buffer.slice(cut))) {
        carry = buffer.slice(cut);
        return scrub(buffer.slice(0, cut));
      }
      carry = '';
      return scrub(buffer);
    },
    /** Flush whatever was held back at end of stream. */
    flush() {
      const tail = carry;
      carry = '';
      return scrub(tail);
    }
  };
}

/** Pull every `data:` payload out of one or more SSE events. */
function ssePayloads(block) {
  const out = [];
  for (const line of String(block || '').split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    out.push(raw);
  }
  return out;
}

function emptyCompletionError(model, detail) {
  const err = new Error(`${model} returned an empty response${detail ? ` (${detail})` : ''}.`);
  err.emptyCompletion = true;
  return err;
}

function buildBody({ model, chatMessages, temperature, maxTokens, stream }) {
  const reasoning = isReasoningModel(model);
  // Reasoning models need headroom or the thinking pass eats the whole answer.
  const budget = reasoning ? Math.max(Number(maxTokens) || 0, REASONING_MIN_BUDGET) : (Number(maxTokens) || 1024);
  // Groq documents 0.5-0.7 for reasoning models; below that they repeat or
  // stall out. Non-reasoning models keep the caller's exact temperature.
  const temp = reasoning ? Math.max(Number(temperature) || 0, 0.5) : temperature;
  return {
    model,
    messages: chatMessages,
    temperature: temp,
    // max_tokens is deprecated on Groq in favour of max_completion_tokens.
    max_completion_tokens: budget,
    stream,
    ...reasoningParams(model)
  };
}

async function postChat(body, signal) {
  const apiKey = (config && config.get && config.get('groqApiKey')) || '';
  const response = await fetch(GROQ_CHAT_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok) {
    let detail = '';
    try { detail = await response.text(); } catch (_) { /* ignore */ }
    const err = new Error(`Groq ${response.status}: ${detail.slice(0, 400)}`);
    err.status = response.status;
    throw err;
  }
  return response;
}

/**
 * Call Groq chat completions for a single model. Streams text chunks to
 * onChunk. Supports multimodal (image) content for vision-capable models via
 * OpenAI-style content parts. Throws on HTTP error with a `.status` property
 * so the router can detect rate limits (429) and fall back to the next model,
 * and throws with `.emptyCompletion = true` when the model produced no visible
 * text so the router can fail over instead of showing a blank answer.
 *
 * @returns {Promise<{text:string, model:string, finishReason:string}>}
 */
async function groqChat({
  model,
  messages,
  system,
  maxTokens = 1024,
  temperature = 0.2,
  onChunk = () => {},
  images = []
} = {}) {
  const apiKey = (config && config.get && config.get('groqApiKey')) || '';
  if (!apiKey) throw new Error('Groq API key is not configured.');

  const imageParts = (Array.isArray(images) ? images : []).map((img) => {
    const buf = img && img.buffer ? (Buffer.isBuffer(img.buffer) ? img.buffer : Buffer.from(img.buffer)) : Buffer.from(img || []);
    const mime = (img && img.mimeType) || 'image/png';
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } };
  });

  const chatMessages = [];
  if (system) chatMessages.push({ role: 'system', content: system });
  for (const m of messages) {
    if (imageParts.length) {
      chatMessages.push({ role: m.role, content: [{ type: 'text', text: String(m.content || '') }, ...imageParts] });
    } else {
      chatMessages.push(m);
    }
  }

  const body = buildBody({ model, chatMessages, temperature, maxTokens, stream: true });

  const controller = new AbortController();
  activeControllers.add(controller);
  const timer = setTimeout(() => controller.abort(), GROQ.requestTimeoutMs);
  let response;
  let text = '';
  let reasoningChars = 0;
  let finishReason = '';
  const filter = createContentFilter();

  const consume = (payload) => {
    let parsed;
    try { parsed = JSON.parse(payload); } catch (_) { return; }
    const choice = parsed.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    // Hidden thinking — counted for diagnostics, never shown to the user.
    const thinking = choice.delta?.reasoning ?? choice.delta?.reasoning_content ?? choice.message?.reasoning;
    if (typeof thinking === 'string') reasoningChars += thinking.length;
    const raw = choice.delta?.content ?? choice.message?.content;
    if (typeof raw !== 'string' || !raw) return;
    const clean = filter.push(raw);
    if (clean) { text += clean; onChunk(clean); }
  };

  try {
    try {
      response = await postChat(body, controller.signal);
    } finally {
      clearTimeout(timer);
    }

    if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
      // Non-streaming fallback (should not happen with stream:true, but be safe).
      const json = await response.json().catch(() => ({}));
      const choice = json.choices?.[0];
      finishReason = choice?.finish_reason || '';
      reasoningChars += String(choice?.message?.reasoning || '').length;
      const clean = filter.push(choice?.message?.content || '') + filter.flush();
      if (clean) { text = clean; onChunk(clean); }
    } else {
      let pending = '';
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        const events = pending.split(/\r?\n\r?\n/);
        pending = events.pop() || '';
        for (const event of events) {
          for (const payload of ssePayloads(event)) consume(payload);
        }
      }
      for (const payload of ssePayloads(pending)) consume(payload);
      const tail = filter.flush();
      if (tail) { text += tail; onChunk(tail); }
    }
  } finally {
    activeControllers.delete(controller);
  }

  if (String(text || '').trim()) return { text, model, finishReason };

  // ── Empty completion rescue ──────────────────────────────────────────────
  // Almost always a reasoning model that spent its whole budget thinking
  // (finish_reason "length", content empty, reasoning non-empty). Retry ONCE,
  // non-streaming, with a much larger budget before giving up.
  const diagnosis = `finish_reason=${finishReason || 'none'}, reasoning=${reasoningChars} chars, budget=${body.max_completion_tokens}`;
  log.warn(`${model} produced no visible text (${diagnosis}) — retrying once with a larger budget.`);

  const retryController = new AbortController();
  activeControllers.add(retryController);
  const retryTimer = setTimeout(() => retryController.abort(), GROQ.requestTimeoutMs);
  try {
    const retryBody = buildBody({
      model,
      chatMessages,
      temperature,
      maxTokens: Math.max(EMPTY_RETRY_BUDGET, Number(body.max_completion_tokens) * 2 || 0),
      stream: false
    });
    const retryResponse = await postChat(retryBody, retryController.signal);
    const json = await retryResponse.json().catch(() => ({}));
    const choice = json.choices?.[0];
    const retryFilter = createContentFilter();
    const clean = (retryFilter.push(choice?.message?.content || '') + retryFilter.flush()).trim();
    if (clean) {
      log.info(`${model} recovered on retry (${clean.length} chars).`);
      onChunk(clean);
      return { text: clean, model, finishReason: choice?.finish_reason || '', recovered: true };
    }
  } catch (retryError) {
    if (retryError?.name === 'AbortError') throw retryError;
    log.warn(`${model} retry after empty completion also failed: ${retryError.message}`);
  } finally {
    clearTimeout(retryTimer);
    activeControllers.delete(retryController);
  }

  throw emptyCompletionError(model, diagnosis);
}

module.exports = {
  groqChat,
  cancelActive,
  GROQ_CHAT_ENDPOINT,
  sleep,
  // exported for tests / router diagnostics
  buildBody,
  reasoningParams,
  isReasoningModel,
  createContentFilter,
  REASONING_MIN_BUDGET
};

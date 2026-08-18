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
 */

const { GROQ } = require('../shared/constants');
const { config } = require('../core/config-store');
const { createLogger } = require('../shared/logger');

const log = createLogger('groq-llm');

const GROQ_CHAT_ENDPOINT = `${GROQ.apiBase}${GROQ.chatEndpoint}`;

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

/**
 * Call Groq chat completions for a single model. Streams text chunks to
 * onChunk. Supports multimodal (image) content for vision-capable models via
 * OpenAI-style content parts. Throws on HTTP error with a `.status` property
 * so the router can detect rate limits (429) and fall back to the next model.
 *
 * @returns {Promise<{text:string, model:string}>}
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

  const body = {
    model,
    messages: chatMessages,
    temperature,
    max_tokens: maxTokens,
    stream: true
  };

  const controller = new AbortController();
  activeControllers.add(controller);
  const timer = setTimeout(() => controller.abort(), GROQ.requestTimeoutMs);
  let response;
  try {
    try {
      response = await fetch(GROQ_CHAT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let detail = '';
      try { detail = await response.text(); } catch (_) { /* ignore */ }
      const err = new Error(`Groq ${response.status}: ${detail.slice(0, 400)}`);
      err.status = response.status;
      throw err;
    }

    let text = '';
    let pending = '';
    const decoder = new TextDecoder();

    if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
      // Non-streaming fallback (should not happen with stream:true, but be safe).
      const json = await response.json().catch(() => ({}));
      text = json.choices?.[0]?.message?.content || '';
      if (text) onChunk(text);
      return { text, model };
    }

    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      const events = pending.split(/\r?\n\r?\n/);
      pending = events.pop() || '';
      for (const event of events) {
        const line = event.split(/\r?\n/).find((l) => l.startsWith('data:'));
        if (!line) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { continue; }
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          onChunk(delta);
        }
      }
    }
    const tail = pending.trim();
    if (tail) {
      const line = tail.split(/\r?\n/).find((l) => l.startsWith('data:'));
      if (line) {
        const raw = line.slice(5).trim();
        if (raw && raw !== '[DONE]') {
          try {
            const parsed = JSON.parse(raw);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) { text += delta; onChunk(delta); }
          } catch (_) { /* ignore */ }
        }
      }
    }

    return { text, model };
  } finally {
    activeControllers.delete(controller);
  }
}

module.exports = { groqChat, cancelActive, GROQ_CHAT_ENDPOINT, sleep };

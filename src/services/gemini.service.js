'use strict';

const {
  GEMINI,
  GEMINI_PRIMARY_MODEL,
  GEMINI_MODEL_CHAIN,
  GEMINI_SELECTABLE_MODELS
} = require('../shared/constants');
const { config } = require('../core/config-store');
const { createLogger } = require('../shared/logger');

const log = createLogger('gemini');

// No alias - use real verified existing models directly
// Verified per https://ai.google.dev/gemini-api/docs/models as of Aug 14 2026:
// gemini-3.7-flash (newest), gemini-3.6-flash, gemini-3.5-flash, gemini-3.5-flash-lite, gemini-3.1-flash-lite
function resolveRealModel(displayModel) {
  return displayModel; // direct, no mapping to 2.5
}

const DIAGNOSTIC_MARKER = /\[(?:diagnostic|synthetic|virtual|test[- ]?audio)\]/i;

function sanitizeTranscript(input) {
  return String(input || '')
    .split(/\r?\n/)
    .filter((line) => line.trim() && !DIAGNOSTIC_MARKER.test(line))
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .trim();
}

function extractResponseText(response) {
  if (!response) return '';
  try {
    const direct = typeof response.text === 'function' ? response.text() : response.text;
    if (typeof direct === 'string') return direct;
  } catch (_) {}
  return (response.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .filter((part) => !part.thought && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function normalizeImages(input) {
  const list = Array.isArray(input) ? input : [input];
  return list.filter(Boolean).map((item) => {
    if (Buffer.isBuffer(item)) return { buffer: item, mimeType: 'image/png' };
    if (item.buffer) {
      return {
        buffer: Buffer.isBuffer(item.buffer) ? item.buffer : Buffer.from(item.buffer),
        mimeType: item.mimeType || 'image/png'
      };
    }
    throw new TypeError('Image must be a Buffer or { buffer, mimeType }.');
  });
}

const ACCURACY_POLICY = `
You are NetworkCap, an accuracy-first AI assistant. Produce only the final answer; do not reveal hidden reasoning.

Reliability rules:
1. Answer the exact request and prioritize the evidence supplied by the user.
2. Never invent missing requirements, APIs, quotations, test results, runtime behavior, or facts.
3. If essential context is missing, state the smallest necessary assumption or ask one concise clarification.
4. Internally check calculations, names, constraints, edge cases, and code consistency before answering.
5. Distinguish verified facts from assumptions. If uncertain, say so plainly and explain how to verify.
6. Do not claim that code was executed unless execution evidence is explicitly present.
7. Prefer a correct, relevant answer over a long answer.

Style rules (concise / to the point):
8. BE CONCISE AND TO THE POINT. Lead with the direct answer. Avoid filler, preambles, greetings, or restating the question.
9. Keep paragraphs short. Aim for the fewest words that fully solve the request — no big, sprawling answers when a short one does the job.
10. When there are distinct key points, steps, pros/cons, or takeaways, present them as a Markdown bullet or numbered list with **bold highlights** on each point so the user can scan them quickly.
11. Use clean Markdown with short headings only when they add clarity. Use fenced code blocks for code. Never wrap the whole response in a code fence.
`.trim();

const SKILL_PROMPTS = Object.freeze({
  interview: `${ACCURACY_POLICY}

Interview-answer mode:
- Give a concise, natural answer a candidate can understand and adapt.
- Start with the useful answer itself.
- For “difference between”, use a clean comparison table and **When to choose which**.
- Order: **Direct answer**, **Why**, **Example**, **Trade-offs**.
- For behavioral, use STAR only when user supplied details; otherwise outline with placeholders.
- Define terms precisely and include most important limitation or trade-off.`,

  coding: `${ACCURACY_POLICY}

Coding mode:
- Identify inputs, outputs, constraints, edge cases before algorithm.
- Present: **Approach**, **Correctness**, **Complexity**, **Implementation**, **Checks**.
- Return complete, idiomatic code in requested language.
- Validate indexing, null/empty, overflow, mutation, complexity.
- If ambiguous, state assumption rather than fabricating signature.`,

  vision: `${ACCURACY_POLICY}

Image-analysis mode:
- Treat all supplied images as one ordered context.
- Identify actual task and transcribe only details required to solve it.
- Mark unreadable/cropped content rather than guessing.
- If images contain code, preserve identifiers exactly before diagnosing.
- Provide directly usable solution and smallest useful verification checklist.`,

  general: ACCURACY_POLICY
});

function verificationPrompt(draft) {
  return `
Quality-control pass. Review candidate answer against request and images.
Correct factual, logical, coding, calculation, relevance, formatting problems. Remove unsupported claims.
Return ONLY polished final answer in Markdown.

<CANDIDATE_ANSWER>
${String(draft || '').slice(0, 30000)}
</CANDIDATE_ANSWER>`;
}

class GeminiService {
  constructor() {
    this.apiKey = '';
    this.client = null;
    this.activeModel = config.get('model') || GEMINI_PRIMARY_MODEL;
    this.deadModels = new Set();
    this.transientFailures = new Map();
    this.lastTransport = null;
    this.history = [];
    this.abortControllers = new Set();
    this.cancelledAt = null;
  }

  configure(apiKey) {
    this.apiKey = String(apiKey || '').trim();
    this.client = null;
    return Boolean(this.apiKey);
  }

  /** Accept any model id (catalog models update over time), not just the
   *  built-in list — users can keep whatever Gemini model they want. */
  selectModel(model) {
    const selected = typeof model === 'string' && model.trim() ? model.trim() : null;
    if (!selected) return false;
    this.activeModel = selected;
    this.deadModels.clear();
    this.transientFailures.clear();
    return true;
  }

  /** All Gemini models known to the app: freshly fetched catalog if available,
   *  otherwise the built-in fallback list. */
  availableModels() {
    const catalog = Array.isArray(config.get('geminiModelCatalog')) ? config.get('geminiModelCatalog') : [];
    const list = catalog.length ? catalog : GEMINI_SELECTABLE_MODELS;
    return [...new Set(list.filter((m) => typeof m === 'string' && m.trim()))];
  }

  /** Fetch the latest Gemini model list from Google (models keep shipping).
   *  Persists the catalog so it also works offline afterwards. */
  async refreshModelCatalog() {
    if (!this.apiKey) return { ok: false, reason: 'Add a Gemini API key first (Settings → Gemini API key).' };
    try {
      const url = `${GEMINI.apiBase}/models`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      let response;
      try {
        response = await fetch(url, { headers: { 'x-goog-api-key': this.apiKey }, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return { ok: false, reason: `Gemini API ${response.status}: ${detail.slice(0, 300)}` };
      }
      const data = await response.json();
      const models = (data.models || [])
        .map((m) => String(m.name || '').replace(/^models\//, ''))
        .filter((name) => /^gemini-/i.test(name) && !/:tuning/i.test(name));
      models.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
      if (!models.length) return { ok: false, reason: 'No gemini-* models returned by the API.' };
      config.set({ geminiModelCatalog: models, geminiCatalogUpdatedAt: Date.now() });
      return { ok: true, models, updatedAt: config.get('geminiCatalogUpdatedAt'), count: models.length };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  }

  status() {
    const catalog = Array.isArray(config.get('geminiModelCatalog')) ? config.get('geminiModelCatalog') : [];
    return {
      configured: Boolean(this.apiKey),
      model: this.activeModel,
      realModel: resolveRealModel(this.activeModel),
      primaryModel: GEMINI_PRIMARY_MODEL,
      transport: this.lastTransport,
      unavailableModels: [...this.deadModels],
      catalog: catalog,
      catalogUpdatedAt: config.get('geminiCatalogUpdatedAt') || 0
    };
  }

  clearHistory() { this.history = []; }
  cancel() {
    this.cancelledAt = Date.now(); // mark user-initiated stop vs timeout abort
    for (const controller of this.abortControllers) {
      try { controller.abort(); } catch (_) { /* ignore */ }
    }
    this.abortControllers.clear();
  }

  _candidates(preferredModels = []) {
    const configured = config.get('model');
    const catalog = Array.isArray(config.get('geminiModelCatalog')) ? config.get('geminiModelCatalog') : [];
    const dynamic = catalog.length ? catalog : GEMINI_SELECTABLE_MODELS;
    const ordered = [...preferredModels, this.activeModel, configured, ...dynamic, ...GEMINI_MODEL_CHAIN].filter(Boolean);
    return [...new Set(ordered)].filter((model) => !this.deadModels.has(model));
  }

  _isModelFailure(error) {
    return /(?:\b404\b|\b403\b|not found|not supported|unsupported model|permission denied)/i.test(String(error?.message || error));
  }

  _isTransient(error) {
    return /(?:\b408\b|\b409\b|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|quota|rate limit|timeout|timed out|aborted|aborterror|socket|network|fetch failed|temporar)/i.test(String(error?.message || error));
  }

  _system(skill) { return SKILL_PROMPTS[skill] || SKILL_PROMPTS.general; }

  _historyContext() {
    if (!this.history.length) return '';
    const recent = this.history.slice(-GEMINI.historyTurns);
    return `\n\nRelevant recent conversation:\n${recent.map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`).join('\n')}`;
  }

  _historyFor(options = {}) {
    const mode = options.qualityMode || config.get('qualityMode') || 'instant';
    return mode === 'instant' ? '' : this._historyContext();
  }

  _generationConfig(displayModel, profile = 'fast') {
    const realModel = resolveRealModel(displayModel);
    const isGemini3 = /^gemini-3/.test(realModel);
    const transcription = profile === 'transcription';
    const instant = profile === 'instant';
    const verified = profile === 'verified';
    const thinkingLevel = transcription || instant ? 'minimal' : verified ? 'high' : 'low';
    const thinkingBudget = transcription || instant ? 0 : verified ? 4096 : 1024;
    // Gemini 3.x uses thinkingLevel, Gemini 2.5 uses thinkingBudget
    const isGemini25 = /^gemini-2\.5/.test(realModel);
    return {
      temperature: transcription ? 0 : instant ? 0.1 : GEMINI.temperature,
      topP: transcription ? 0.8 : instant ? 0.82 : GEMINI.topP,
      maxOutputTokens: transcription ? 1024 : instant ? 2048 : verified ? GEMINI.maxOutputTokens : 2048,
      ...(isGemini3 ? { thinkingConfig: { thinkingLevel, includeThoughts: false } } : isGemini25 ? { thinkingConfig: { thinkingBudget, includeThoughts: false } } : {})
    };
  }

  _requestTimeout(profile = 'fast') {
    if (profile === 'transcription') return 16000;
    if (profile === 'instant') return 14000;
    if (profile === 'verified') return GEMINI.requestTimeoutMs;
    return 30000;
  }

  async verify() {
    if (!this.apiKey) return { ok: false, reason: 'Gemini API key is not configured.' };
    try {
      const result = await this._streamParts([{ text: 'Reply with exactly: NetworkCap connection verified' }], () => {}, { systemPrompt: 'Return exact phrase.', direct: true });
      return { ok: true, model: result.model, realModel: result.realModel, transport: result.transport };
    } catch (error) { return { ok: false, reason: error.message }; }
  }

  async transcribeAudio(audio, mimeType = 'audio/wav') {
    const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []);
    if (!buffer.length) throw new Error('No microphone audio was captured.');
    const systemPrompt = ['You are a precise speech-to-text engine.', 'Return only the words actually spoken.', 'Do not answer, summarize, or invent.', 'If no speech, return exactly <NO_SPEECH>.'].join(' ');
    const result = await this._streamParts(
      [{ text: 'Transcribe this microphone recording faithfully. Output transcript text only.' }, { inlineData: { mimeType, data: buffer.toString('base64') } }],
      () => {},
      { systemPrompt, direct: true, generationProfile: 'transcription', preferredModels: ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'], transportMode: 'single-only' }
    );
    let text = String(result.text || '').replace(/^```(?:text)?\s*/i, '').replace(/```\s*$/, '').replace(/^(?:transcript|transcription)\s*:\s*/i, '').trim();
    if (!text || /^(?:<NO_SPEECH>|NO_SPEECH|\[NO SPEECH\])$/i.test(text)) text = '';
    return { ...result, text };
  }

  async processTextWithSkillStream(text, skill = 'general', onChunk = () => {}, options = {}) {
    const cleaned = String(text || '').trim();
    if (!cleaned) throw new Error('Enter a question before sending.');
    const parts = [{ text: cleaned + this._historyFor(options) }];
    const result = await this._answer(parts, skill, onChunk, options);
    this._remember(cleaned, result.text);
    return result;
  }

  async processTranscriptionWithSkillStream(text, skill = 'interview', onChunk = () => {}, options = {}) {
    const cleaned = sanitizeTranscript(text);
    if (!cleaned) throw new Error('No real speech remained after diagnostic filtering.');
    const prompt = ['The text inside <voice_question> is the user’s spoken question.', 'ANSWER the request directly.', '', '<voice_question>', cleaned, '</voice_question>'].join('\n');
    const result = await this._answer([{ text: prompt + this._historyFor(options) }], skill, onChunk, options);
    this._remember(cleaned, result.text);
    return result;
  }

  async processAudioQuestionWithSkillStream(audio, skill = 'interview', onChunk = () => {}, options = {}) {
    const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []);
    if (!buffer.length) throw new Error('No microphone audio was supplied.');
    const prompt = ['Listen to the attached audio and answer directly.', 'Do not output transcript.', this._historyFor(options)].filter(Boolean).join('\n');
    return this._answer([{ text: prompt }, { inlineData: { mimeType: 'audio/wav', data: buffer.toString('base64') } }], skill, onChunk, { ...options, directAudio: true });
  }

  async processImageWithSkillStream(images, skill = 'vision', onChunk = () => {}, options = {}) {
    const normalized = normalizeImages(images);
    if (!normalized.length) throw new Error('No image was supplied.');
    const parts = [{ text: `Analyze all ${normalized.length} image${normalized.length === 1 ? '' : 's'} in order as one task.` }, ...normalized.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.buffer.toString('base64') } }))];
    return this._answer(parts, skill, onChunk, options);
  }

  /**
   * Direct model chat used by the 3-tier LLM router (Tier 3 primary/fallback, and
   * Tier 1 fallback). Calls a SPECIFIC Gemini model with optional images and streams
   * chunks to onChunk. There is no fallback chain here — the router handles tier
   * failover. Throws on error so the router can fall back to the tier's secondary model.
   * @returns {Promise<{text:string, model:string, transport:string}>}
   */
  async chat({ model, query = '', images = [], onChunk = () => {}, systemPrompt = ACCURACY_POLICY, maxTokens = 4096, temperature = 0.2, profile = 'fast' } = {}) {
    if (!this.apiKey) throw new Error('Gemini API key is not configured. Open Settings and add one.');
    const realModel = resolveRealModel(model);
    const parts = [];
    if (query) parts.push({ text: query });
    for (const image of normalizeImages(images)) {
      parts.push({ inlineData: { mimeType: image.mimeType, data: image.buffer.toString('base64') } });
    }
    if (!parts.length) throw new Error('chat() requires a query or images.');
    const text = await this._restStream(realModel, model, parts, systemPrompt, onChunk, profile, 60000);
    if (!String(text || '').trim()) throw new Error('Gemini returned an empty response.');
    this.lastTransport = 'rest-sse';
    return { text, model: realModel, transport: 'rest-sse' };
  }

  async _answer(parts, skill, onChunk, options = {}) {
    const baseSystemPrompt = this._system(skill);
    const qualityMode = options.qualityMode || config.get('qualityMode') || 'instant';
    const configured = config.get('model');
    const selected = typeof configured === 'string' && configured.trim() ? configured : this.availableModels()[0] || GEMINI_SELECTABLE_MODELS[0];
    const lowLatencyModels = [selected, ...this.availableModels(), 'gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.7-flash'];

    if (qualityMode === 'instant') {
      return this._streamParts(parts, onChunk, {
        systemPrompt: `${baseSystemPrompt}\n\nInstant mode: begin with answer immediately. Fewest words that solve request.`,
        direct: true, generationProfile: 'instant', preferredModels: lowLatencyModels, transportMode: 'stream-only'
      });
    }

    if (qualityMode !== 'verified' || options.direct) {
      return this._streamParts(parts, onChunk, {
        systemPrompt: baseSystemPrompt, direct: true, generationProfile: 'fast', preferredModels: lowLatencyModels, transportMode: 'stream-only'
      });
    }

    let draft;
    try {
      draft = await this._streamParts(parts, () => {}, { systemPrompt: baseSystemPrompt, direct: true, generationProfile: 'fast', preferredModels: lowLatencyModels, transportMode: 'single-only' });
    } catch (error) {
      log.warn('Draft failed; direct final:', error.message);
      return this._streamParts(parts, onChunk, { systemPrompt: baseSystemPrompt, direct: true, generationProfile: 'fast', preferredModels: lowLatencyModels, transportMode: 'stream-only' });
    }

    const reviewParts = [...parts, { text: verificationPrompt(draft.text) }];
    const final = await this._streamParts(reviewParts, onChunk, {
      systemPrompt: `${baseSystemPrompt}\n\nFinal verifier. Correct errors, never add unsupported detail.`,
      direct: true, generationProfile: 'verified', preferredModels: [selected, GEMINI_PRIMARY_MODEL, 'gemini-3.6-flash'], transportMode: 'stream-first'
    });
    return { ...final, verified: true, draftModel: draft.model };
  }

  _remember(user, assistant) {
    this.history.push({ role: 'user', text: String(user).slice(0, 5000) });
    this.history.push({ role: 'assistant', text: String(assistant).slice(0, 8000) });
    this.history = this.history.slice(-GEMINI.historyTurns * 2);
  }

  async _streamParts(parts, onChunk = () => {}, options = {}) {
    if (!this.apiKey) throw new Error('Gemini API key is not configured. Open Settings and add one.');
    const systemPrompt = options.systemPrompt || ACCURACY_POLICY;
    const profile = options.generationProfile || 'fast';
    const timeoutMs = this._requestTimeout(profile);
    const mode = options.transportMode || 'stream-only';
    const overallMs = profile === 'transcription' ? 24000 : profile === 'instant' ? 24000 : profile === 'verified' ? 120000 : 50000;
    const deadline = Date.now() + overallMs;
    const errors = [];
    const modelLimit = profile === 'verified' ? 4 : profile === 'instant' || profile === 'transcription' ? 2 : 3;
    const candidatesDisplay = this._candidates(options.preferredModels || []).slice(0, modelLimit);

    for (const displayModel of candidatesDisplay) {
      if (Date.now() >= deadline) break;
      const realModel = resolveRealModel(displayModel);
      const remaining = () => Math.max(1000, Math.min(timeoutMs, deadline - Date.now()));
      const catalog = {
        'rest-sse': () => this._restStream(realModel, displayModel, parts, systemPrompt, onChunk, profile, remaining()),
        rest: () => this._restGenerate(realModel, displayModel, parts, systemPrompt, onChunk, profile, remaining()),
        'sdk-stream': () => this._sdkStream(realModel, displayModel, parts, systemPrompt, onChunk, profile)
      };
      const order = mode === 'single-only' ? ['rest'] : mode === 'single-first' ? ['rest', 'rest-sse'] : mode === 'stream-only' ? ['rest-sse'] : profile === 'verified' ? ['rest-sse', 'rest', 'sdk-stream'] : ['rest-sse', 'rest'];

      for (const transport of order) {
        try {
          const text = await catalog[transport]();
          if (!String(text || '').trim()) throw new Error('Gemini returned an empty response.');
          // Don't auto-switch activeModel to fallback - keep user's selected model
          // Only update if this was the user's selected model or activeModel is not set
          if (displayModel === this.activeModel || !this.activeModel) {
            this.activeModel = displayModel;
          }
          this.lastTransport = transport;
          this.transientFailures.delete(displayModel);
          log.info(`Response via ${displayModel}=>${realModel}/${transport}/${profile} (${text.length} chars)`);
          return { text, model: displayModel, realModel, transport, profile };
        } catch (error) {
          const message = `${displayModel}=>${realModel}/${transport}: ${error.message}`;
          errors.push(message);
          log.warn(message);
          if (this._isModelFailure(error)) { this.deadModels.add(displayModel); break; }
          if (this._isTransient(error)) this.transientFailures.set(displayModel, (this.transientFailures.get(displayModel) || 0) + 1);
        }
      }
    }

    const detail = errors.slice(-4).join(' | ');
    throw new Error(`Gemini request failed. ${detail}`);
  }

  _client() {
    if (!this.client) {
      const { GoogleGenAI } = require('@google/genai');
      this.client = new GoogleGenAI({ apiKey: this.apiKey });
    }
    return this.client;
  }

  async _sdkStream(realModel, displayModel, parts, systemPrompt, onChunk, profile = 'verified') {
    const stream = await this._client().models.generateContentStream({
      model: realModel,
      contents: [{ role: 'user', parts }],
      config: { systemInstruction: systemPrompt, ...this._generationConfig(displayModel, profile) }
    });
    let text = '';
    for await (const chunk of stream) {
      const delta = extractResponseText(chunk);
      if (delta) { text += delta; onChunk(delta); }
    }
    return text;
  }

  _restBody(realModel, displayModel, parts, systemPrompt, profile = 'fast') {
    return {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts }],
      generationConfig: this._generationConfig(displayModel, profile),
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
      ]
    };
  }

  async _fetch(url, body, timeoutMs) {
    const controller = new AbortController();
    this.abortControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const cleanup = () => { clearTimeout(timer); this.abortControllers.delete(controller); };
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey }, body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok) { const errorText = await response.text(); cleanup(); throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 500)}`); }
      return { response, cleanup };
    } catch (error) {
      cleanup();
      if (error?.name === 'AbortError') {
        if (this.cancelledAt && Date.now() - this.cancelledAt < 2000) throw new Error('Generation stopped by user.');
        throw new Error(`Gemini request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
      }
      throw error;
    }
  }

  async _restStream(realModel, displayModel, parts, systemPrompt, onChunk, profile = 'fast', timeoutMs = 45000) {
    const url = `${GEMINI.apiBase}/models/${encodeURIComponent(realModel)}:streamGenerateContent?alt=sse`;
    const handle = await this._fetch(url, this._restBody(realModel, displayModel, parts, systemPrompt, profile), timeoutMs);
    const { response, cleanup } = handle;
    if (!response.body) { cleanup(); throw new Error('Streaming response had no body.'); }
    let text = ''; let pending = ''; const decoder = new TextDecoder();
    const consume = (event) => {
      for (const line of event.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        const parsed = JSON.parse(raw);
        const delta = extractResponseText(parsed);
        if (delta) { text += delta; onChunk(delta); }
      }
    };
    try {
      for await (const buffer of response.body) {
        pending += decoder.decode(buffer, { stream: true });
        const events = pending.split(/\r?\n\r?\n/);
        pending = events.pop() || '';
        for (const event of events) consume(event);
      }
      pending += decoder.decode();
      if (pending.trim()) consume(pending);
      return text;
    } catch (error) {
      if (text.trim()) { log.warn(`Stream ended after partial ${text.length} chars: ${error.message}`); return text; }
      if (error?.name === 'AbortError') {
        if (this.cancelledAt && Date.now() - this.cancelledAt < 2000) throw new Error('Generation stopped by user.');
        throw new Error(`Gemini stream timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
      }
      throw error;
    } finally { cleanup(); }
  }

  async _restGenerate(realModel, displayModel, parts, systemPrompt, onChunk, profile = 'fast', timeoutMs = 45000) {
    const url = `${GEMINI.apiBase}/models/${encodeURIComponent(realModel)}:generateContent`;
    const { response, cleanup } = await this._fetch(url, this._restBody(realModel, displayModel, parts, systemPrompt, profile), timeoutMs);
    try { const parsed = await response.json(); const text = extractResponseText(parsed); if (text) onChunk(text); return text; } finally { cleanup(); }
  }
}

const geminiService = new GeminiService();
module.exports = { GeminiService, geminiService, sanitizeTranscript, normalizeImages, extractResponseText, SKILL_PROMPTS, ACCURACY_POLICY, resolveRealModel };

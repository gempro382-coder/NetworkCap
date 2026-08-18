'use strict';

/**
 * 3-tier LLM complexity router.
 *
 * Every user question passes through a two-stage classifier (fast regex
 * heuristics, then a micro-LLM classifier only when confidence is low), and is
 * then dispatched to the right model:
 *
 *   Tier 1 (Simple)  -> openai/gpt-oss-20b (Groq)  | fallback gemini-3.1-flash-lite
 *   Tier 2 (Moderate)-> openai/gpt-oss-120b (Groq) | fallback qwen/qwen3.6-27b (Groq)
 *   Tier 3 (Hard)    -> gemini-3.7-flash (Google)  | fallback gemini-3.6-flash (Google)
 *
 * Every API call is tracked by a shared RateTracker so the UI can render live
 * quota usage for all models. Per the NetworkCap v5.0 architecture prompt.
 */

const { EventEmitter } = require('events');
const { LLM_TIERS, FAST_ANSWER_MODEL } = require('../shared/constants');
const { RateTracker } = require('./rate-tracker');
const { groqChat, cancelActive } = require('./groq-llm.service');
const { geminiService, ACCURACY_POLICY } = require('./gemini.service');
const { config } = require('../core/config-store');
const { createLogger } = require('../shared/logger');

const log = createLogger('llm-router');

const CLASSIFIER_MODEL = 'openai/gpt-oss-20b';

// Second fast partner for Tier 3 (used if the configured Groq fast model is
// unavailable). flash-lite is the fastest Gemini model and needs no extra key.
const FAST_GEMINI_FALLBACK = 'gemini-3.5-flash-lite';

function isRateLimit(error) {
  return Number(error?.status) === 429 ||
    /(?:quota|rate.?limit|too many requests|RESOURCE_EXHAUSTED|429)/i.test(String(error?.message || ''));
}

// True when the request was cancelled by the user (Stop / Ctrl+Shift+K) rather
// than failing on its own — the router must NOT fail over to another model then.
function isAbortError(error) {
  return error?.name === 'AbortError' ||
    /(?:abort|stopped by user|generation stopped)/i.test(String(error?.message || error));
}

function estimateTokens(text) {
  return Math.ceil((String(text || '').length) / 4);
}

// ---------------------------------------------------------------------------
// Stage 1 — Fast heuristics (zero latency). Returns a tier when confident.
// ---------------------------------------------------------------------------
function classifyFast(query) {
  const trimmed = query.trim();
  const wordCount = trimmed.split(/\s+/).length;
  const hasCodeBlock = /```[\s\S]*```/.test(trimmed);
  const hasStackTrace = /\b(Traceback|at\s+\w+\.\w+\(|Exception|Error:)\b/i.test(trimmed);
  const lower = trimmed.toLowerCase();

  // ── HARD signals (highest priority) ──
  if (hasCodeBlock || hasStackTrace) return { tier: 3, confidence: 0.95, reason: 'code_block_or_stacktrace' };
  const hardKeywords = /\b(implement algorithm|dynamic programming|time complexity|proof|debug this|stack trace|system design|leetcode|optimize this code|binary tree|linked list|recursion|backtracking)\b/i;
  if (hardKeywords.test(trimmed)) return { tier: 3, confidence: 0.90, reason: 'hard_keyword' };

  // ── SIMPLE signals ──
  if (wordCount <= 8) {
    const simplePatterns = /^(hi|hello|hey|thanks|thank you|good morning|good night|what is|who is|define|translate|meaning of)\b/i;
    if (simplePatterns.test(lower)) return { tier: 1, confidence: 0.95, reason: 'greeting_or_short_lookup' };
  }
  if (wordCount <= 25 && !hasCodeBlock) {
    const simpleKeywords = /\b(what is|who is|define|when did|where is|how old|translate|capital of|meaning of|abbreviation)\b/i;
    if (simpleKeywords.test(lower)) return { tier: 1, confidence: 0.85, reason: 'simple_keyword_short_query' };
  }

  // ── MODERATE signals ──
  const moderateKeywords = /\b(compare|explain how|step.by.step|pros and cons|differences? between|summarize|refactor|convert|advantages|disadvantages|elaborate|describe in detail)\b/i;
  if (moderateKeywords.test(lower)) return { tier: 2, confidence: 0.85, reason: 'moderate_keyword' };
  if (wordCount > 25 && wordCount <= 80) return { tier: 2, confidence: 0.70, reason: 'medium_length_query' };
  if (wordCount > 80) return { tier: 3, confidence: 0.85, reason: 'long_complex_query' };

  // ── DEFAULT: uncertain → go to Stage 2 ──
  return { tier: 2, confidence: 0.50, reason: 'uncertain_needs_llm_classify' };
}

const CLASSIFIER_SYSTEM = `You are a question complexity classifier. Respond with ONLY one word: "simple", "moderate", or "hard".

Rules:
- "simple": greetings, single factual lookups, definitions, translations, yes/no questions, queries under 20 words with no technical depth.
- "moderate": explanations, comparisons, multi-step reasoning, structured output requests, summaries, pros/cons analysis.
- "hard": algorithm implementation, code debugging, math proofs, system architecture, dynamic programming, multi-variable logic, code with stack traces.

Respond with ONLY the single word.`;

class LlmRouter extends EventEmitter {
  constructor() {
    super();
    this.classifierCallsToday = 0;

    // Build a deduped model -> limits map from the LLM tiers.
    const llmModels = {};
    for (const tier of Object.values(LLM_TIERS)) {
      llmModels[tier.primary.id] = {
        rpm: tier.primary.rpm, rpd: tier.primary.rpd,
        tpm: tier.primary.tpm, tpd: tier.primary.tpd
      };
      llmModels[tier.fallback.id] = {
        rpm: tier.fallback.rpm, rpd: tier.fallback.rpd,
        tpm: tier.fallback.tpm, tpd: tier.fallback.tpd
      };
    }
    this.tracker = new RateTracker(llmModels);
  }

  status() {
    return {
      classifierCallsToday: this.classifierCallsToday,
      tracker: this.tracker.getSnapshot()
    };
  }

  // -------------------------------------------------------------------------
  // Stage 2 — Micro-LLM classifier (only when Stage 1 confidence < 80%).
  // -------------------------------------------------------------------------
  async classifyWithLLM(query) {
    this.classifierCallsToday += 1;
    this.tracker.recordUsage(CLASSIFIER_MODEL, { requests: 1, tokens: 2 });
    this._emitTracker();

    let label = '';
    try {
      const res = await groqChat({
        model: CLASSIFIER_MODEL,
        messages: [{ role: 'user', content: query }],
        system: CLASSIFIER_SYSTEM,
        maxTokens: 5,
        temperature: 0
      });
      label = (res.text || '').trim().toLowerCase();
    } catch (error) {
      // Fallback to ultra fast gemini
      try {
        const res = await geminiService.chat({
          model: 'gemini-3.1-flash-lite',
          query: `Classify the complexity of this question as exactly one word (simple, moderate, or hard): ${query}`,
          systemPrompt: CLASSIFIER_SYSTEM,
          maxTokens: 5,
          temperature: 0
        });
        label = (res.text || '').trim().toLowerCase();
      } catch (_) {
        label = 'moderate';
      }
    }

    const tierMap = { simple: 1, moderate: 2, hard: 3 };
    return tierMap[label] || 2; // default moderate if unclear
  }

  // -------------------------------------------------------------------------
  // Combined router
  // -------------------------------------------------------------------------
  async routeQuestion(query) {
    const fast = classifyFast(query);
    if (fast.confidence >= 0.80) {
      return { tier: fast.tier, method: 'heuristic', reason: fast.reason };
    }
    const llmTier = await this.classifyWithLLM(query);
    return { tier: llmTier, method: 'llm_classifier', reason: 'micro_llm_decision' };
  }

  tierKeyFor(tier) {
    return tier === 1 ? 'simple' : tier === 2 ? 'moderate' : 'hard';
  }

  /** Effective tier definition: built-in defaults merged with any user override
   *  saved in config (tierOverrides). Lets users keep ANY model per tier. */
  _effectiveTier(tierKey) {
    const base = LLM_TIERS[tierKey];
    const ov = (config.get('tierOverrides') || {})[tierKey] || {};
    const primaryId = typeof ov.primary === 'string' && ov.primary.trim() ? ov.primary.trim() : base.primary.id;
    const fallbackId = typeof ov.fallback === 'string' && ov.fallback.trim() ? ov.fallback.trim() : base.fallback.id;
    const tier = {
      primary: { ...base.primary, id: primaryId },
      fallback: { ...base.fallback, id: fallbackId },
      extraFallbacks: Array.isArray(base.extraFallbacks) ? base.extraFallbacks : []
    };
    // Make the rate tracker aware of runtime-picked models.
    this.tracker.ensureModel(primaryId, tier.primary);
    this.tracker.ensureModel(fallbackId, tier.fallback);
    for (const extra of tier.extraFallbacks) this.tracker.ensureModel(extra.id, extra);
    return tier;
  }

  /** Ordered failover chain for a tier: primary → fallback → extra fallbacks. */
  _modelChain(tierKey) {
    const tier = this._effectiveTier(tierKey);
    const ids = [];
    const push = (m) => { if (m && typeof m.id === 'string' && m.id && !ids.includes(m.id)) ids.push(m.id); };
    push(tier.primary);
    push(tier.fallback);
    for (const extra of tier.extraFallbacks) push(extra);
    return ids;
  }

  _maxTokensFor(tierKey, modelId) {
    const tier = this._effectiveTier(tierKey);
    for (const m of [tier.primary, tier.fallback, ...tier.extraFallbacks]) {
      if (m && m.id === modelId && m.maxOutput) return m.maxOutput;
    }
    return 1024;
  }

  _fastAnswerModel() {
    const m = String(config.get('fastAnswerModel') || FAST_ANSWER_MODEL).trim();
    this.tracker.ensureModel(m, { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 });
    return m;
  }

  // -------------------------------------------------------------------------
  // Dispatch after routing
  // -------------------------------------------------------------------------
  async dispatch({ query, images = [], skill = 'general', forceTier = null, onChunk = () => {}, onRouted, onModel, onFallback, requestId = '' } = {}) {
    const route = forceTier
      ? { tier: Number(forceTier), method: 'forced', reason: 'forced_tier' }
      : await this.routeQuestion(query);
    const tierKey = this.tierKeyFor(route.tier);
    const tier = this._effectiveTier(tierKey);
    const primaryId = tier.primary.id;
    const maxTokens = tier.primary.maxOutput || tier.fallback.maxOutput || 1024;

    if (onRouted) onRouted({ tier: route.tier, method: route.method, reason: route.reason, model: primaryId, requestId });
    this.emit('routed', { tier: route.tier, method: route.method, reason: route.reason, model: primaryId, requestId });
    this._emitTracker();

    const result = await this._callTier(tierKey, { query, images, onChunk, onModel, onFallback, maxTokens, requestId });
    return { ...result, tier: route.tier, method: route.method, reason: route.reason, requestId };
  }

  async _callTier(tierKey, { query, images, onChunk, onModel, onFallback, maxTokens, requestId = '' }) {
    // Tier 3 (Hard): answer instantly with a fast partner chain (Groq → fast
    // Gemini), then the Tier-3 chain replaces it once a (better) answer lands.
    // Images go through the same fast path — gpt-oss and flash-lite are multimodal.
    if (tierKey === 'hard') {
      return this._callTierHardFast({ query, images, onChunk, onModel, onFallback, maxTokens, requestId });
    }
    return this._callTierChain(tierKey, { query, images, onChunk, onModel, onFallback, maxTokens });
  }

  // Stream a tier's whole chain (primary → fallback → extras) with instant
  // failover on ANY failure. Used for Tier 1/2 and as the final fallback.
  async _callTierChain(tierKey, { query, images, onChunk, onModel, onFallback, maxTokens }) {
    const chain = this._modelChain(tierKey);
    let lastError = null;
    for (let i = 0; i < chain.length; i++) {
      const modelId = chain[i];
      try {
        return await this._invoke(modelId, query, images, onChunk, onModel, this._maxTokensFor(tierKey, modelId) || maxTokens);
      } catch (err) {
        if (isAbortError(err)) throw err; // user pressed Stop — no failover
        lastError = err;
        const next = chain[i + 1];
        log.warn(`[${tierKey}] ${modelId} failed (${err.message})${next ? ` → trying ${next}` : ''}`);
        if (next) {
          if (onFallback) onFallback({ fromModel: modelId, toModel: next, reason: err.message });
          this.emit('fallback', { fromModel: modelId, toModel: next, reason: err.message });
        }
      }
    }
    throw lastError || new Error('No model available for this tier.');
  }

  /**
   * Tier-3 fast path.
   *
   * Foreground: a fast partner chain streams a first answer to the UI almost
   * instantly (Groq fast model, falling back to a fast Gemini flash-lite).
   * Background: the "real" Tier-3 chain runs at the same time; its chunks are
   * buffered and its FINAL answer is emitted via 'upgraded' so the renderer
   * replaces the fast answer in place. If every fast partner fails, the Tier-3
   * answer is streamed live so the user always sees progress.
   */
  async _callTierHardFast({ query, images = [], onChunk, onModel, onFallback, maxTokens, requestId = '' }) {
    const rid = requestId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const upgradeChain = this._modelChain('hard');
    const fastCandidates = [this._fastAnswerModel(), FAST_GEMINI_FALLBACK]
      .filter((m, i, arr) => m && arr.indexOf(m) === i)
      .filter((m) => !upgradeChain.includes(m));

    // No distinct fast partner available (user picked Gemini models only) →
    // just stream the Tier-3 chain live like any other tier.
    if (!fastCandidates.length) {
      return this._callTierChain('hard', { query, images, onChunk, onModel, onFallback, maxTokens });
    }

    let fastFailed = false;
    let upgradeBuffer = '';

    // ── Background: the "real" Tier-3 answer — walks the whole Tier-3 chain
    // (default → fallback → extras) with instant failover on ANY failure. ──
    const upgradePromise = (async () => {
      let lastError = null;
      for (let i = 0; i < upgradeChain.length; i++) {
        const modelId = upgradeChain[i];
        try {
          const res = await this._invoke(modelId, query, images, (delta) => {
            upgradeBuffer += delta;
            // If the fast chain died, keep the user's screen moving.
            if (fastFailed) onChunk(delta);
          }, onModel, this._maxTokensFor('hard', modelId) || maxTokens);
          this.emit('upgraded', { text: res.text, model: res.model, requestId: rid });
          return res;
        } catch (err) {
          if (isAbortError(err)) {
            // User pressed Stop — abort the whole upgrade, no failover.
            this.emit('upgrade-failed', { error: 'Stopped by user', requestId: rid });
            return null;
          }
          lastError = err;
          const next = upgradeChain[i + 1];
          log.warn(`[tier3-upgrade] ${modelId} failed (${err.message})${next ? ` → trying ${next}` : ''}`);
          if (next) {
            if (onFallback) onFallback({ fromModel: modelId, toModel: next, reason: err.message });
            this.emit('fallback', { fromModel: modelId, toModel: next, reason: err.message });
          }
        }
      }
      this.emit('upgrade-failed', { error: lastError ? lastError.message : 'All Tier-3 models failed', requestId: rid });
      return null;
    })();

    // ── Foreground: stream the fast partner chain instantly ──
    let lastFastError = null;
    for (let i = 0; i < fastCandidates.length; i++) {
      const modelId = fastCandidates[i];
      this.emit('fast-start', { model: modelId, requestId: rid });
      try {
        const fastRes = await this._invoke(modelId, query, images, onChunk, onModel, 512);
        // Fire-and-forget: the upgrade keeps running and emits 'upgraded' when done.
        upgradePromise.catch(() => {});
        return { ...fastRes, fast: true, upgradePending: true };
      } catch (err) {
        if (isAbortError(err)) { lastFastError = err; break; } // user stopped
        lastFastError = err;
        const next = fastCandidates[i + 1];
        log.warn(`Fast partner ${modelId} failed (${err.message})${next ? ` → trying ${next}` : ''}`);
        if (next) {
          if (onFallback) onFallback({ fromModel: modelId, toModel: next, reason: err.message });
          this.emit('fallback', { fromModel: modelId, toModel: next, reason: err.message });
        }
      }
    }

    // User pressed Stop while the fast answer was streaming — bail out now.
    if (isAbortError(lastFastError)) throw lastFastError;

    // Every fast partner failed → stream the Tier-3 answer live (flush what
    // Gemini already produced, then forward its remaining chunks).
    fastFailed = true;
    if (upgradeBuffer) onChunk(upgradeBuffer);
    const upgraded = await upgradePromise;
    if (upgraded && upgraded.text) return { ...upgraded, fast: false, upgradePending: false };
    throw lastFastError || new Error('All models failed for this question.');
  }

  async _invoke(modelId, query, images, onChunk, onModel, maxTokens = 1024) {
    const isGemini = modelId.startsWith('gemini-');
    const resume = String(config.get('resume') || '').trim();
    const systemPrompt = resume
      ? `${ACCURACY_POLICY}\n\n---\nUser's resume / background (pasted by the user in NetworkCap Settings — treat it as ground truth about them):\n${resume}\n---\nYou HAVE this resume in your context. If the user asks "do you have my resume", "do you know me", or anything about themselves, confirm using their resume and answer from it. Always check the resume FIRST for questions about their skills, experience, projects, education, or background, and tailor answers accordingly.`
      : ACCURACY_POLICY;
    let text;
    if (isGemini) {
      const res = await geminiService.chat({
        model: modelId,
        query,
        images,
        onChunk,
        maxTokens,
        systemPrompt
      });
      text = res.text;
    } else {
      const res = await groqChat({
        model: modelId,
        messages: [{ role: 'user', content: query }],
        system: systemPrompt,
        maxTokens,
        onChunk,
        images
      });
      text = res.text;
    }
    const tokens = estimateTokens(text);
    this.tracker.recordUsage(modelId, { requests: 1, tokens });
    if (onModel) onModel({ model: modelId });
    this._emitTracker();
    return { text, model: modelId };
  }

  _emitTracker() {
    const snapshot = this.tracker.getSnapshot();
    this.emit('tracker-update', snapshot);
  }

  /** Hard-stop every in-flight answer: Groq fast/tier calls AND Gemini calls. */
  cancel() {
    try { cancelActive(); } catch (_) { /* ignore */ }
    try { geminiService.cancel(); } catch (_) { /* ignore */ }
  }
}

const llmRouter = new LlmRouter();
module.exports = { LlmRouter, llmRouter, classifyFast, isRateLimit, isAbortError };

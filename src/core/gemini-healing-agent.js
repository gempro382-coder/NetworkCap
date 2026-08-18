'use strict';

const { geminiService } = require('../services/gemini.service');
const { createLogger } = require('../shared/logger');

const log = createLogger('healing');

const BANNER = String.raw`
     _        _    ____  _   _ ___
    / \      / \  / ___|| | | |_ _|
   / _ \    / _ \ \___ \| |_| || |
  / ___ \  / ___ \ ___) |  _  || |
 /_/   \_\\_/_/   \_\\____/|_| |_|___|
       SAFE SELF-HEALING AGENT - GROQ + GEMINI EDITION
`;

const CATEGORIES = Object.freeze({
  MODEL: 'model-routing',
  API_KEY: 'api-key',
  NETWORK: 'network',
  UNKNOWN: 'unknown'
});

class GeminiHealingAgent {
  constructor(options = {}) {
    this.gemini = options.gemini || geminiService;
    this.maxAttemptsPerCategory = 3;
    this.attempts = Object.fromEntries(Object.values(CATEGORIES).map((k) => [k, 0]));
    this.history = [];
    this._lastSignature = null;
    this._sameCount = 0;
  }

  showBanner() { console.log(BANNER); }

  diagnose(error) {
    const msg = String(error?.message || error || 'unknown');
    let cat = CATEGORIES.UNKNOWN;
    if (/\b401\b|unauthenticated|api.?key|invalid key|permission denied/i.test(msg)) {
      cat = CATEGORIES.API_KEY;
    } else if (/gemini|generativelanguage|\b404\b.*model|model .*not found|quota|rate.?limit|\b429\b/i.test(msg)) {
      cat = CATEGORIES.MODEL;
    } else if (/network|fetch failed|socket|timeout|timed out|econnrefused|enotfound|dns/i.test(msg)) {
      cat = CATEGORIES.NETWORK;
    }
    return { category: cat, message: msg, at: new Date().toISOString() };
  }

  async heal(error, context = {}) {
    const diagnosis = this.diagnose(error);
    const category = diagnosis.category;

    const sig = `${category}:${String(error && error.message).slice(0, 120)}`;
    if (this._lastSignature === sig && this._sameCount >= 1) {
      return this._record({
        ok: false,
        strategy: category,
        actions: ['Identical failure repeated — not retrying. See the actions above.'],
        diagnosis,
        context
      });
    }
    this._sameCount = this._lastSignature === sig ? (this._sameCount || 0) + 1 : 0;
    this._lastSignature = sig;

    if ((this.attempts[category] || 0) >= this.maxAttemptsPerCategory) {
      return this._record({
        ok: false,
        strategy: category,
        actions: ['Attempt limit reached; automatic repair stopped.'],
        diagnosis,
        context
      });
    }
    this.attempts[category] = (this.attempts[category] || 0) + 1;

    let result;
    switch (category) {
      case CATEGORIES.API_KEY: result = { ok: false, actions: ['Open Settings and enter a valid Groq and Gemini API key.'] }; break;
      case CATEGORIES.MODEL: result = await this.strategyModelFallback(diagnosis); break;
      case CATEGORIES.NETWORK: result = { ok: false, actions: ['Check your internet connection — NetworkCap needs Groq and Google endpoints.'] }; break;
      default: result = { ok: false, actions: ['No safe automatic repair matches this failure; inspect the log.'] };
    }
    return this._record({ ...result, strategy: category, diagnosis, context });
  }

  async strategyModelFallback(diagnosis) {
    const actions = [];
    const current = this.gemini.activeModel;
    if (current) {
      this.gemini.deadModels.add(current);
      actions.push(`Retired unavailable model ${current} for this session.`);
    }
    const next = (this.gemini.constructor && this.gemini.GEMINI_MODEL_CHAIN
      ? this.gemini.GEMINI_MODEL_CHAIN
      : []).find((model) => !this.gemini.deadModels.has(model));
    if (next) {
      this.gemini.activeModel = next;
      actions.push(`Pinned fallback model ${next}.`);
      return { ok: true, actions };
    }
    actions.push('No healthy Gemini model remains in the configured fallback chain.');
    return { ok: false, actions };
  }

  _record(entry) {
    const value = { at: new Date().toISOString(), ...entry };
    this.history.push(value);
    this.history = this.history.slice(-50);
    log.info(value);
    return value;
  }

  getHistory() { return [...this.history]; }
}

module.exports = { GeminiHealingAgent, CATEGORIES, BANNER };

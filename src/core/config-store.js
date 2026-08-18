'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS, GEMINI_SELECTABLE_MODELS, SCREENSHOT_MODES, FAST_ANSWER_MODEL, STT_MODELS, STT_MODEL_OPTIONS } = require('../shared/constants');
const { ensureDirs } = require('../shared/logger');

const DEFAULTS = Object.freeze({
  configVersion: 13,
  // Two API keys drive everything: Groq (STT + Tier 1/2 LLM + classifier) and
  // Gemini (Tier 3 hard + Tier 1 fallback).
  groqApiKey: '',
  geminiApiKey: '',
  // Preferred Gemini model (used for Tier 3 hard questions and Tier 1 fallback).
  model: 'gemini-3.7-flash',
  // Preferred Whisper model for Speech-to-Text (Groq).
  sttModel: STT_MODELS.primary.id,
  // Fast "first-answer" partner model (Groq) for Tier 3 hard questions.
  fastAnswerModel: FAST_ANSWER_MODEL,
  // Per-tier overrides: { simple: { primary, fallback }, moderate: {...}, hard: {...} }.
  // Missing entries fall back to the built-in defaults in LLM_TIERS.
  tierOverrides: {},
  // Freshly fetched Gemini model catalog (see "Update Gemini models" in settings).
  geminiModelCatalog: [],
  geminiCatalogUpdatedAt: 0,
  qualityMode: 'instant',
  skill: 'interview',
  opacity: 1,
  clickThrough: false,
  screenshotMode: SCREENSHOT_MODES.normal,
  resume: ''
});

class ConfigStore {
  constructor(file = PATHS.config) {
    this.file = file;
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    ensureDirs();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const legacyMode = SCREENSHOT_MODES[parsed.screenshotMode] ? parsed.screenshotMode : SCREENSHOT_MODES.normal;
        const tierOverrides = parsed.tierOverrides && typeof parsed.tierOverrides === 'object' && !Array.isArray(parsed.tierOverrides)
          ? parsed.tierOverrides
          : {};
        const migrated = {
          ...parsed,
          configVersion: DEFAULTS.configVersion,
          groqApiKey: typeof parsed.groqApiKey === 'string' ? parsed.groqApiKey : '',
          geminiApiKey: typeof parsed.geminiApiKey === 'string' ? parsed.geminiApiKey : '',
          model: typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model : DEFAULTS.model,
          sttModel: STT_MODEL_OPTIONS.some((m) => m.id === parsed.sttModel) ? parsed.sttModel : DEFAULTS.sttModel,
          fastAnswerModel: typeof parsed.fastAnswerModel === 'string' && parsed.fastAnswerModel.trim() ? parsed.fastAnswerModel : DEFAULTS.fastAnswerModel,
          tierOverrides,
          geminiModelCatalog: Array.isArray(parsed.geminiModelCatalog) ? parsed.geminiModelCatalog.filter((m) => typeof m === 'string') : [],
          geminiCatalogUpdatedAt: Number.isFinite(Number(parsed.geminiCatalogUpdatedAt)) ? Number(parsed.geminiCatalogUpdatedAt) : 0,
          qualityMode: ['instant', 'fast', 'verified'].includes(parsed.qualityMode) ? parsed.qualityMode : 'instant',
          skill: ['interview', 'coding', 'general'].includes(parsed.skill) ? parsed.skill : 'interview',
          screenshotMode: SCREENSHOT_MODES[legacyMode],
          resume: typeof parsed.resume === 'string' ? parsed.resume : ''
        };
        this.data = { ...DEFAULTS, ...migrated };
        this.save();
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        try {
          fs.renameSync(this.file, `${this.file}.invalid-${Date.now()}`);
        } catch (_) { /* ignore */ }
      }
    }
    return this.data;
  }

  get(key) {
    if (key == null) return { ...this.data };
    return this.data[key];
  }

  set(key, value) {
    if (key && typeof key === 'object') this.data = { ...this.data, ...key };
    else this.data[key] = value;
    this.save();
    return this.get(key && typeof key !== 'object' ? key : undefined);
  }

  save() {
    ensureDirs();
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch (_) { /* ignore */ }
  }
}

const config = new ConfigStore();
module.exports = { ConfigStore, config, DEFAULTS };

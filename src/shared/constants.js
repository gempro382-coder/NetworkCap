'use strict';

const os = require('os');
const path = require('path');

const APP_NAME = 'NetworkCap';
const APP_PACKAGE = 'networkcap';
const APP_ID = 'com.networkcap.app';
const APP_AUTHOR = 'Aashish';
const APP_AUTHOR_EMAIL = 'aashish@aashi.ai';
const APP_AUTHOR_URL = 'https://aashi.ai';
const APP_AUTHOR_HANDLE = '@Aashish';
const APP_DATA_DIR = path.join(os.homedir(), '.networkcap');

const PATHS = Object.freeze({
  root: APP_DATA_DIR,
  config: path.join(APP_DATA_DIR, 'config.json'),
  logs: path.join(APP_DATA_DIR, 'logs'),
  cache: path.join(APP_DATA_DIR, 'cache')
});

const BOOT_SIZE = Object.freeze({ width: 680, height: 520 });
const OVERLAY_SIZE = Object.freeze({ width: 440, height: 36 });

const SHORTCUTS = Object.freeze({
  toggleRecording: 'CommandOrControl+Shift+V',
  stageImage: 'CommandOrControl+Shift+S',
  sendStaged: 'CommandOrControl+Shift+D',
  toggleClickThrough: 'CommandOrControl+Shift+X',
  toggleVisibility: 'CommandOrControl+Shift+H',
  toggleVisibilityAlt: 'CommandOrControl+Alt+H',
  resetWindow: 'CommandOrControl+Shift+R',
  opacityUp: 'CommandOrControl+Shift+Up',
  opacityDown: 'CommandOrControl+Shift+Down',
  toggleTerminal: 'CommandOrControl+Shift+T',
  quit: 'CommandOrControl+W',
  clearLastStaged: 'CommandOrControl+Shift+Q',
  stopAI: 'CommandOrControl+Shift+K',
  cycleScreenshotMode: 'CommandOrControl+Shift+M',
  showShortcuts: 'CommandOrControl+Shift+L',
  // Dedicated "close the shortcuts help" hotkey. Shift+/ is '?' on most
  // layouts, so both accelerators are registered and both close the panel.
  closeShortcuts: 'CommandOrControl+Shift+/',
  closeShortcutsAlt: 'CommandOrControl+Shift+?',
  closeResponse: 'CommandOrControl+Shift+O'
});

// UI-only key handling that lives in the renderer (no global accelerator) but
// must still be listed in the "All Shortcuts" help panel.
const RENDERER_ONLY_SHORTCUTS = Object.freeze([
  { accel: 'Ctrl+Left / Right', label: 'Scroll wide code / tables' },
  { accel: 'Ctrl+Up / Down', label: 'Scroll the answer' },
  { accel: 'Enter / Shift+Enter', label: 'Send question / newline (Ask box)' },
  { accel: 'Esc', label: 'Close popovers (pinned help panel stays)' }
]);

/** Pretty-print an Electron accelerator for display in the help panel. */
function prettyAccel(accel, platform = process.platform) {
  return String(accel)
    .replace(/CommandOrControl/gi, platform === 'darwin' ? 'Cmd' : 'Ctrl')
    .replace(/\bControl\b/gi, 'Ctrl')
    .replace(/\bUp\b/g, '↑')
    .replace(/\bDown\b/g, '↓')
    .replace(/\bLeft\b/g, '←')
    .replace(/\bRight\b/g, '→');
}

// ---------------------------------------------------------------------------
// Gemini (Google AI Studio) — used for Tier 3 (hard) and Tier 1 fallback.
// ---------------------------------------------------------------------------
const GEMINI_PRIMARY_MODEL = 'gemini-3.7-flash';
const GEMINI_FALLBACK_CHAIN = Object.freeze([
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite'
]);
const GEMINI_MODEL_CHAIN = Object.freeze([GEMINI_PRIMARY_MODEL, ...GEMINI_FALLBACK_CHAIN]);
const GEMINI_SELECTABLE_MODELS = Object.freeze([
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.7-flash'
]);

const GEMINI = Object.freeze({
  primaryModel: GEMINI_PRIMARY_MODEL,
  fallbackChain: GEMINI_FALLBACK_CHAIN,
  apiBase: 'https://generativelanguage.googleapis.com/v1beta',
  requestTimeoutMs: 120000,
  maxOutputTokens: 8192,
  temperature: 0.14,
  topP: 0.88,
  historyTurns: 6
});

// ---------------------------------------------------------------------------
// Groq (cloud) — STT + Tier 1/2 LLM + micro-classifier.
// ---------------------------------------------------------------------------
const GROQ = Object.freeze({
  apiBase: 'https://api.groq.com/openai/v1',
  sttEndpoint: '/audio/transcriptions',
  chatEndpoint: '/chat/completions',
  requestTimeoutMs: 30000
});

// STT: Groq Whisper API only (no local models).
const STT_MODELS = Object.freeze({
  primary: {
    id: 'whisper-large-v3-turbo',
    rpm: 20, rpd: 2000,
    audioSecPerHr: 7200, audioSecPerDay: 28800
  },
  fallback: {
    id: 'whisper-large-v3',
    rpm: 20, rpd: 2000,
    audioSecPerHr: 7200, audioSecPerDay: 28800
  }
});

// Selectable Whisper models for Speech-to-Text (Settings → STT model).
const STT_MODEL_OPTIONS = Object.freeze([
  { id: 'whisper-large-v3-turbo', label: 'Whisper Large V3 Turbo — fast & accurate (default)' },
  { id: 'whisper-large-v3', label: 'Whisper Large V3 — most accurate' }
]);

// 3-tier LLM routing. Each tier has an ordered failover chain:
// primary -> fallback -> extraFallbacks — if a model fails (rate limit, HTTP
// error, timeout, invalid key), the router instantly moves to the next model.
const LLM_TIERS = Object.freeze({
  // NOTE on maxOutput: Groq reasoning models (gpt-oss, qwen) spend part of this
  // budget on hidden thinking BEFORE emitting visible text. A 256-token cap
  // made Tier 1 return empty answers for simple questions, so the floor is
  // 1024 here and re-asserted in groq-llm.service.js. The answer-style prompt
  // is what keeps replies short — not the token cap.
  simple: {
    label: 'Tier 1 — Simple',
    primary: { id: 'openai/gpt-oss-20b', rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000, maxOutput: 1024 },
    fallback: { id: 'gemini-3.1-flash-lite', rpm: null, rpd: null, tpm: null, tpd: null, maxOutput: 1024 },
    extraFallbacks: []
  },
  moderate: {
    label: 'Tier 2 — Moderate',
    primary: { id: 'openai/gpt-oss-120b', rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000, maxOutput: 1024 },
    fallback: { id: 'qwen/qwen3.6-27b', rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000, maxOutput: 1024 },
    extraFallbacks: [{ id: 'gemini-3.5-flash-lite', rpm: null, rpd: null, tpm: null, tpd: null, maxOutput: 1024 }]
  },
  hard: {
    label: 'Tier 3 — Hard',
    primary: { id: 'gemini-3.7-flash', rpm: null, rpd: null, tpm: null, tpd: null, maxOutput: 2048 },
    fallback: { id: 'gemini-3.6-flash', rpm: null, rpd: null, tpm: null, tpd: null, maxOutput: 2048 },
    extraFallbacks: [{ id: 'gemini-3.5-flash', rpm: null, rpd: null, tpm: null, tpd: null, maxOutput: 2048 }]
  }
});

const SCREENSHOT_MODES = Object.freeze({
  normal: 'normal',
  // Legacy values are kept so old configs migrate cleanly to the single mode.
  hard: 'normal',
  onlyHard: 'normal'
});

// Fast "first-answer" partner used only for Tier 3 (Hard) questions: the 20B
// model minimizes first-token latency while the top Tier-3 model independently
// processes the same request and replaces this draft when its response is ready.
const FAST_ANSWER_MODEL = 'openai/gpt-oss-20b';

// Groq models offered in the Model Routing settings (fast tiers + fast partner).
const GROQ_MODELS = Object.freeze([
  { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B (Groq) — fastest simple answers' },
  { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B (Groq) — fast + capable' },
  { id: 'qwen/qwen3.6-27b', label: 'Qwen 3.6 27B (Groq) — fast' },
  { id: 'meta-llama/llama-3.3-70b-versatile', label: 'Llama 3.3 70B (Groq) — versatile' }
]);

module.exports = {
  APP_NAME,
  APP_PACKAGE,
  APP_ID,
  APP_AUTHOR,
  APP_AUTHOR_EMAIL,
  APP_AUTHOR_URL,
  APP_AUTHOR_HANDLE,
  APP_DATA_DIR,
  PATHS,
  BOOT_SIZE,
  OVERLAY_SIZE,
  SHORTCUTS,
  RENDERER_ONLY_SHORTCUTS,
  prettyAccel,
  SCREENSHOT_MODES,
  FAST_ANSWER_MODEL,
  GROQ_MODELS,
  GEMINI_PRIMARY_MODEL,
  GEMINI_FALLBACK_CHAIN,
  GEMINI_MODEL_CHAIN,
  GEMINI_SELECTABLE_MODELS,
  GEMINI,
  GROQ,
  STT_MODELS,
  STT_MODEL_OPTIONS,
  LLM_TIERS
};

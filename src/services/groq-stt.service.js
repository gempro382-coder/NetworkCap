'use strict';

/**
 * Groq Whisper STT service.
 *
 * Cloud-only speech transcription. Voice audio is sent as a single REST call to
 * the Groq Whisper API:
 *   POST https://api.groq.com/openai/v1/audio/transcriptions
 *
 * Implements the dual-model failover and live rate tracking described in the
 * NetworkCap v5.0 architecture prompt (Groq STT + 3-tier LLM routing).
 */

const { EventEmitter } = require('events');
const { GROQ, STT_MODELS, STT_MODEL_OPTIONS } = require('../shared/constants');
const { RateTracker } = require('./rate-tracker');
const { config } = require('../core/config-store');
const { createLogger } = require('../shared/logger');

const log = createLogger('groq-stt');

const GROQ_STT_ENDPOINT = `${GROQ.apiBase}${GROQ.sttEndpoint}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a multipart/form-data body manually so we never depend on the global
 * FormData/Blob availability across Node/Electron versions.
 */
function buildMultipart({ fields = {}, file }) {
  const boundary = `----AashiFormBoundary${Date.now()}${Math.random().toString(16).slice(2)}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
    parts.push(Buffer.from(`${value}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from(
      `Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n`
    ));
    parts.push(Buffer.from(`Content-Type: ${file.contentType}\r\n\r\n`));
    parts.push(Buffer.from(file.data));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

class GroqSttService extends EventEmitter {
  constructor(apiKey) {
    super();
    this.apiKey = apiKey || '';
    // User-chosen Whisper model (Settings → STT model); falls back to default.
    const chosen = STT_MODEL_OPTIONS.some((m) => m.id === config.get('sttModel')) ? config.get('sttModel') : STT_MODELS.primary.id;
    this.primaryModel = chosen;
    this.fallbackModel = STT_MODELS.fallback.id;
    this.tracker = new RateTracker({
      [this.primaryModel]: {
        rpm: STT_MODELS.primary.rpm,
        rpd: STT_MODELS.primary.rpd,
        audioSecPerHr: STT_MODELS.primary.audioSecPerHr,
        audioSecPerDay: STT_MODELS.primary.audioSecPerDay
      },
      [this.fallbackModel]: {
        rpm: STT_MODELS.fallback.rpm,
        rpd: STT_MODELS.fallback.rpd,
        audioSecPerHr: STT_MODELS.fallback.audioSecPerHr,
        audioSecPerDay: STT_MODELS.fallback.audioSecPerDay
      }
    });
  }

  setApiKey(apiKey) {
    this.apiKey = String(apiKey || '').trim();
    return Boolean(this.apiKey);
  }

  status() {
    return {
      configured: Boolean(this.apiKey),
      model: this.primaryModel,
      primaryModel: this.primaryModel,
      fallbackModel: this.fallbackModel,
      availableModels: STT_MODEL_OPTIONS.map((m) => m.id),
      remaining: this.tracker.getSnapshot()
    };
  }

  /** Change the Whisper model used for transcription (persisted via config). */
  setModel(modelId) {
    const option = STT_MODEL_OPTIONS.find((m) => m.id === modelId);
    if (!option) return false;
    this.primaryModel = option.id;
    // Make sure the rate tracker knows the newly chosen model.
    const limits = STT_MODELS.primary;
    this.tracker.ensureModel(option.id, {
      rpm: limits.rpm, rpd: limits.rpd,
      audioSecPerHr: limits.audioSecPerHr, audioSecPerDay: limits.audioSecPerDay
    });
    this.emit('tracker-update', this.tracker.getSnapshot());
    log.info(`STT model set to ${option.id}`);
    return true;
  }

  _pickModel() {
    const primaryRemaining = this.tracker.getRemaining(this.primaryModel);
    // Switch threshold: when primary has <= 1 request remaining in the current
    // minute window, route to the fallback model automatically.
    if (primaryRemaining.rpm > 1) return this.primaryModel;
    const fallbackRemaining = this.tracker.getRemaining(this.fallbackModel);
    if (fallbackRemaining.rpm > 0) return this.fallbackModel;
    return this.primaryModel; // both may be exhausted; caller will detect and queue
  }

  async _transcribeWith(model, audioBuffer, audioDurationSec) {
    // Use native FormData + Blob (available globally in Node 20 / Electron 43)
    // to build a correct multipart request and let Node compute Content-Length.
    const formData = new FormData();
    formData.append('model', model);
    formData.append('response_format', 'json');
    formData.append('language', 'en');
    // Wrap audio bytes as a Blob with the correct type so the filename extension
    // matches. Groq's Whisper endpoint validates the file header.
    const blob = new Blob([audioBuffer], { type: 'audio/wav' });
    formData.append('file', blob, 'audio.wav');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GROQ.requestTimeoutMs);
    let response;
    try {
      response = await fetch(GROQ_STT_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: formData,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const err = new Error(`Groq STT ${response.status}: ${text.slice(0, 300)}`);
      err.status = response.status;
      throw err;
    }

    const json = await response.json().catch(() => ({}));
    const text = typeof json.text === 'string' ? json.text.trim() : '';
    return text;
  }

  /**
   * Transcribe a recorded audio buffer.
   * @param {Buffer|ArrayBuffer} audioBuffer raw audio bytes (WAV)
   * @param {number} audioDurationSec duration of the clip in seconds
   * @returns {Promise<{text:string, model:string, latencyMs:number, queued:boolean}|null>}
   *          Returns null if both models are rate-limited and the clip was dropped.
   */
  async transcribe(audioBuffer, audioDurationSec) {
    if (!this.apiKey) throw new Error('Groq API key is not configured.');
    const buffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
    if (!buffer.length) return null;
    // Audio too short (< 0.5s): skip transcription to avoid wasting quota.
    if (Number(audioDurationSec) > 0 && Number(audioDurationSec) < 0.5) {
      log.info('Audio too short (<0.5s) — skipping transcription to save quota.');
      return { text: '', model: null, latencyMs: 0, skipped: true };
    }

    let model = this._pickModel();
    let remaining = this.tracker.getRemaining(model);
    const other = model === this.primaryModel ? this.fallbackModel : this.primaryModel;
    const otherRemaining = this.tracker.getRemaining(other);

    const exhausted =
      (remaining.rpm <= 0 || remaining.rpd <= 0 ||
        remaining.audioSecHr <= 0 || remaining.audioSecDay <= 0);

    if (exhausted && otherRemaining.rpm > 0) {
      model = other;
      remaining = otherRemaining;
    }

    // Both models exhausted: queue and retry after the earliest reset window.
    if (remaining.rpm <= 0 || remaining.rpd <= 0 ||
        remaining.audioSecHr <= 0 || remaining.audioSecDay <= 0) {
      const retryAfterMs = this._msUntilMinuteReset();
      this.emit('rate-limited', { model, retryAfterMs });
      // Queue the audio and retry once the window resets (cap the wait).
      await sleep(Math.min(retryAfterMs, 60_000) + 250);
      model = this._pickModel();
      remaining = this.tracker.getRemaining(model);
      if (remaining.rpm <= 0 || remaining.rpd <= 0) {
        // Still blocked after waiting — give up on this clip.
        this.emit('rate-limited', { model, retryAfterMs: this._msUntilMinuteReset() });
        return null;
      }
    }

    const started = Date.now();
    const text = await this._transcribeWith(model, buffer, audioDurationSec);
    const latencyMs = Date.now() - started;

    this.tracker.recordUsage(model, { requests: 1, audioSec: audioDurationSec || 0 });
    this.emit('tracker-update', this.tracker.getSnapshot());

    return { text, model, latencyMs };
  }

  _msUntilMinuteReset() {
    const anyModel = Object.keys(this.tracker.models)[0];
    if (!anyModel) return 60_000;
    const start = this.tracker.models[anyModel].usage.minuteWindowStart;
    return Math.max(0, 60_000 - (Date.now() - start));
  }
}

module.exports = { GroqSttService, GROQ_STT_ENDPOINT };

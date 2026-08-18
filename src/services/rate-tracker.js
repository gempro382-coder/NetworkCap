'use strict';

/**
 * Shared rate-limit tracker used by both the Groq STT service and the
 * 3-tier LLM router. Sliding-window counters reset on their natural cadence
 * (per-minute, per-hour, per-day at midnight UTC) so the UI can render live
 * quota usage for every model.
 *
 * Per the NetworkCap v5.0 architecture prompt (Groq STT + 3-tier LLM routing).
 */

class RateTracker {
  constructor(modelsConfig) {
    // modelsConfig = { 'model-id': { rpm, rpd, tpm, tpd, audioSecPerHr, audioSecPerDay } }
    this.models = {};
    for (const [id, limits] of Object.entries(modelsConfig)) {
      this.models[id] = {
        limits: {
          rpm: limits.rpm ?? null,
          rpd: limits.rpd ?? null,
          tpm: limits.tpm ?? null,
          tpd: limits.tpd ?? null,
          audioSecPerHr: limits.audioSecPerHr ?? null,
          audioSecPerDay: limits.audioSecPerDay ?? null
        },
        usage: {
          requestsThisMinute: 0,
          requestsToday: 0,
          tokensThisMinute: 0,
          tokensToday: 0,
          audioSecThisHour: 0,
          audioSecToday: 0,
          minuteWindowStart: Date.now(),
          hourWindowStart: Date.now(),
          dayStart: this._todayMidnightUTC()
        }
      };
    }
  }

  /** Register a model at runtime (used when users override tier models or pick
   *  models not present in the built-in tier defaults). No-op if already known. */
  ensureModel(modelId, limits = {}) {
    if (!modelId || this.models[modelId]) return this.models[modelId];
    this.models[modelId] = {
      limits: {
        rpm: limits.rpm ?? null,
        rpd: limits.rpd ?? null,
        tpm: limits.tpm ?? null,
        tpd: limits.tpd ?? null,
        audioSecPerHr: limits.audioSecPerHr ?? null,
        audioSecPerDay: limits.audioSecPerDay ?? null
      },
      usage: {
        requestsThisMinute: 0,
        requestsToday: 0,
        tokensThisMinute: 0,
        tokensToday: 0,
        audioSecThisHour: 0,
        audioSecToday: 0,
        minuteWindowStart: Date.now(),
        hourWindowStart: Date.now(),
        dayStart: this._todayMidnightUTC()
      }
    };
    return this.models[modelId];
  }

  recordUsage(modelId, { requests = 0, tokens = 0, audioSec = 0 } = {}) {
    const m = this.models[modelId];
    if (!m) return;
    this._maybeReset(modelId);
    m.usage.requestsThisMinute += requests;
    m.usage.requestsToday += requests;
    m.usage.tokensThisMinute += tokens;
    m.usage.tokensToday += tokens;
    m.usage.audioSecThisHour += audioSec;
    m.usage.audioSecToday += audioSec;
  }

  getRemaining(modelId) {
    const m = this.models[modelId];
    if (!m) return null;
    this._maybeReset(modelId);
    return {
      rpm: (m.limits.rpm != null ? m.limits.rpm : Infinity) - m.usage.requestsThisMinute,
      rpd: (m.limits.rpd != null ? m.limits.rpd : Infinity) - m.usage.requestsToday,
      tpm: (m.limits.tpm != null ? m.limits.tpm : Infinity) - m.usage.tokensThisMinute,
      tpd: (m.limits.tpd != null ? m.limits.tpd : Infinity) - m.usage.tokensToday,
      audioSecHr: (m.limits.audioSecPerHr != null ? m.limits.audioSecPerHr : Infinity) - m.usage.audioSecThisHour,
      audioSecDay: (m.limits.audioSecPerDay != null ? m.limits.audioSecPerDay : Infinity) - m.usage.audioSecToday
    };
  }

  getSnapshot() {
    // Returns full state for UI rendering
    const snap = {};
    for (const [id, m] of Object.entries(this.models)) {
      this._maybeReset(id);
      snap[id] = {
        limits: { ...m.limits },
        usage: { ...m.usage },
        remaining: this.getRemaining(id)
      };
    }
    return snap;
  }

  _maybeReset(modelId) {
    const u = this.models[modelId].usage;
    const now = Date.now();
    if (now - u.minuteWindowStart >= 60_000) {
      u.requestsThisMinute = 0;
      u.tokensThisMinute = 0;
      u.minuteWindowStart = now;
    }
    if (now - u.hourWindowStart >= 3_600_000) {
      u.audioSecThisHour = 0;
      u.hourWindowStart = now;
    }
    const todayMidnight = this._todayMidnightUTC();
    if (u.dayStart < todayMidnight) {
      u.requestsToday = 0;
      u.tokensToday = 0;
      u.audioSecToday = 0;
      u.dayStart = todayMidnight;
    }
  }

  _todayMidnightUTC() {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }
}

module.exports = { RateTracker };

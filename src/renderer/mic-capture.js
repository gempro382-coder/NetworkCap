'use strict';

// Chromium microphone capture. Records 16 kHz mono float32, encodes a WAV, and
// sends it to the main process which transcribes it via the Groq Whisper API.
// No local speech model is involved.
(() => {
  const api = window.aashi;
  const TARGET_RATE = 16000;
  const MAX_CAPTURE_SECONDS = 300;

  let capturing = false;
  let stream = null, ctx = null, source = null, processor = null, sink = null;
  let recorded = [];          // float32 chunks captured this take
  let recordedLen = 0;
  let sampleCount = 0;
  let lastLevelAt = 0;

  function downsample(input, sourceRate) {
    if (sourceRate === TARGET_RATE) return Float32Array.from(input);
    const ratio = sourceRate / TARGET_RATE;
    const length = Math.max(1, Math.floor(input.length / ratio));
    const output = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      output[i] = sum / (end - start);
    }
    return output;
  }

  function measure(input) {
    let peak = 0, squares = 0;
    for (let i = 0; i < input.length; i++) {
      const v = Number.isFinite(input[i]) ? input[i] : 0;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      squares += v * v;
    }
    return { peak, rms: input.length ? Math.sqrt(squares / input.length) : 0 };
  }

  function join(list, total) {
    const out = new Float32Array(total);
    let off = 0;
    for (const c of list) { out.set(c, off); off += c.length; }
    return out;
  }

  function encodeWav(float32, sampleRate) {
    const samples = float32.length;
    const buffer = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(buffer);
    // NOTE: every write uses an EXPLICIT absolute offset. Mixing a running
    // `off` counter with absolute setUint32/setUint16 calls corrupts the
    // header (WAVE/fmt/data land in the wrong bytes), which makes the Groq
    // Whisper API reject the file as invalid media.
    const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF');
    view.setUint32(4, 36 + samples * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);   // PCM integer
    view.setUint16(22, 1, true);   // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);   // block align
    view.setUint16(34, 16, true);  // bits per sample
    str(36, 'data');
    view.setUint32(40, samples * 2, true);
    let o = 44;
    for (let i = 0; i < samples; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      view.setInt16(o, s < 0 ? s * 32768 : s * 32767, true);
      o += 2;
    }
    return buffer;
  }

  async function start() {
    if (capturing) return { ok: false, reason: 'microphone-busy' };
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      ctx = new AudioContext({ latencyHint: 'interactive' });
      if (ctx.state === 'suspended') await ctx.resume();
      source = ctx.createMediaStreamSource(stream);
      processor = ctx.createScriptProcessor(4096, 1, 1);
      sink = ctx.createGain();
      sink.gain.value = 0;

      recorded = []; recordedLen = 0; sampleCount = 0; lastLevelAt = 0;
      capturing = true;

      processor.onaudioprocess = (event) => {
        if (!capturing) return;
        const mono = event.inputBuffer.getChannelData(0);
        const pcm = downsample(mono, ctx.sampleRate);
        if (sampleCount + pcm.length > TARGET_RATE * MAX_CAPTURE_SECONDS) return;
        sampleCount += pcm.length;
        recorded.push(pcm); recordedLen += pcm.length;
        const now = performance.now();
        if (now - lastLevelAt >= 80) {
          lastLevelAt = now;
          window.dispatchEvent(new CustomEvent('aashi-capture-level', { detail: measure(mono) }));
        }
      };
      source.connect(processor);
      processor.connect(sink);
      sink.connect(ctx.destination);   // ScriptProcessor only runs when connected
      return { ok: true };
    } catch (err) {
      capturing = false;
      cleanup();
      window.dispatchEvent(new CustomEvent('aashi-capture-status', {
        detail: { ok: false, reason: 'getusermedia-failed', message: err.message }
      }));
      return { ok: false, reason: 'getusermedia-failed', message: err.message };
    }
  }

  function cleanup() {
    try { if (processor) { processor.onaudioprocess = null; processor.disconnect(); } } catch (_) { }
    try { if (source) source.disconnect(); } catch (_) { }
    try { if (sink) sink.disconnect(); } catch (_) { }
    if (stream) stream.getTracks().forEach((t) => t.stop());
  }

  async function stop({ micTest = false } = {}) {
    if (!capturing && !stream) return { ok: true };
    capturing = false;
    cleanup();
    if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => {});
    const durationSec = recordedLen / TARGET_RATE;
    if (recordedLen > 0) {
      const float32 = join(recorded, recordedLen);
      const wav = encodeWav(float32, TARGET_RATE);
      if (micTest) api.submitMicTestAudio(wav, durationSec);
      else api.transcribeAudio(wav, durationSec);
    } else if (micTest) {
      api.submitMicTestAudio(new ArrayBuffer(0), 0);
    }
    stream = ctx = source = processor = sink = null;
    recorded = []; recordedLen = 0; sampleCount = 0;
    return { ok: true };
  }

  api.onRecordingState((active) => {
    if (active && !capturing) start();
    else if (!active && capturing) stop();
  });
  api.onBrowserMicTest(async (request) => {
    const started = await start();
    if (!started.ok) { api.submitMicTestAudio(new ArrayBuffer(0), 0); return; }
    const secs = Math.max(1, Math.min(15, Number(request && request.seconds) || 4));
    await new Promise((r) => setTimeout(r, secs * 1000));
    await stop({ micTest: true });
  });
})();

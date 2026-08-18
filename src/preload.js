'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('aashi', {
  appRoot: process.env.AASHI_ROOT || require('path').resolve(__dirname, '..'),

  // ---- boot / lifecycle ----
  getBootStatus: () => ipcRenderer.invoke('get-boot-status'),
  verifyEnvironment: () => ipcRenderer.invoke('verify-environment'),
  startAashi: () => ipcRenderer.invoke('start-aashi'),
  runMicTest: (seconds) => ipcRenderer.invoke('run-mic-test', seconds),

  // ---- config ----
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (patch) => ipcRenderer.invoke('set-config', patch),
  getScreenshotMode: () => ipcRenderer.invoke('get-screenshot-mode'),
  setScreenshotMode: (mode) => ipcRenderer.invoke('set-screenshot-mode', mode),
  cycleScreenshotMode: () => ipcRenderer.invoke('cycle-screenshot-mode'),
  getAvailableModels: () => ipcRenderer.invoke('get-available-models'),
  refreshGeminiModels: () => ipcRenderer.invoke('refresh-gemini-models'),

  // ---- recording (browser mic) ----
  toggleRecording: () => ipcRenderer.invoke('toggle-recording'),
  transcribeAudio: (audioBuffer, durationSec) => ipcRenderer.invoke('stt:transcribe', { audioBuffer, durationSec }),
  submitMicTestAudio: (buffer, durationSec) => ipcRenderer.invoke('mic-test-audio', { pcm: buffer, durationSec }),
  stopGeneration: () => ipcRenderer.invoke('stop-generation'),

  // ---- LLM (3-tier router) ----
  askQuestion: ({ query, images, skill, forceTier } = {}) =>
    ipcRenderer.invoke('llm:ask', { query, images, skill, forceTier }),

  // ---- staging tray ----
  stageScreenshot: () => ipcRenderer.invoke('stage-screenshot'),
  sendStagedImages: (skill) => ipcRenderer.invoke('send-staged-images', { skill }),
  captureAndSend: (skill) => ipcRenderer.invoke('capture-and-send', { skill }),
  clearStagedImages: () => ipcRenderer.invoke('clear-staged-images'),
  removeStagedImage: (id) => ipcRenderer.invoke('remove-staged-image', id),
  removeLastStagedImage: () => ipcRenderer.invoke('remove-last-staged-image'),
  getStagedImages: () => ipcRenderer.invoke('get-staged-images'),

  // ---- window ----
  toggleClickThrough: () => ipcRenderer.invoke('toggle-click-through'),
  toggleVisibility: () => ipcRenderer.invoke('toggle-visibility'),
  resetWindow: () => ipcRenderer.invoke('reset-window'),
  setOpacity: (value) => ipcRenderer.invoke('set-opacity', value),
  resizeOverlay: (height) => ipcRenderer.invoke('resize-overlay', height),
  quit: () => ipcRenderer.invoke('quit-app'),

  // ---- healing ----
  runHealing: (message) => ipcRenderer.invoke('run-healing', message),
  getHealingHistory: () => ipcRenderer.invoke('get-healing-history'),

  // ---- admin / terminal ----
  isAdmin: () => ipcRenderer.invoke('is-admin'),
  relaunchAsAdmin: () => ipcRenderer.invoke('relaunch-as-admin'),
  terminalExec: (commandLine) => ipcRenderer.invoke('terminal-exec', commandLine),
  terminalInput: (data) => ipcRenderer.invoke('terminal-input', data),
  terminalKill: () => ipcRenderer.invoke('terminal-kill'),
  terminalStatus: () => ipcRenderer.invoke('terminal-status'),

  // ---- events ----
  onBootLog: on('boot-log'),
  onBootProgress: on('boot-progress'),
  onMicTestLevel: on('mic-test-level'),
  onMicTestResult: on('mic-test-result'),
  onAudioLevel: on('audio-level'),
  onRecordingState: on('recording-state'),
  onStagedImagesUpdated: on('staged-images-updated'),
  onStatus: on('status-update'),
  onShowOverlay: on('show-overlay'),
  onClickThrough: on('click-through-state'),
  onOpacityChanged: on('opacity-changed'),
  onHealing: on('healing-update'),
  onTerminalOutput: on('terminal-output'),
  onTerminalExit: on('terminal-exit'),
  onTerminalClear: on('terminal-clear'),
  onTerminalToggle: on('terminal-toggle'),
  onScreenshotModeChanged: on('screenshot-mode-changed'),
  onShowShortcuts: on('show-shortcuts'),
  onCloseResponseOverlay: on('close-response-overlay'),

  // ---- STT (Groq Whisper) ----
  onSttResult: on('stt:result'),
  onSttTrackerUpdate: on('stt:tracker-update'),
  onSttRateLimited: on('stt:rate-limited'),

  // ---- LLM (3-tier) ----
  onLlmRouted: on('llm:routed'),
  onLlmChunk: on('llm:chunk'),
  onLlmTrackerUpdate: on('llm:tracker-update'),
  onLlmFallback: on('llm:fallback'),
  onLlmFastStart: on('llm:fast-start'),
  onLlmUpgrade: on('llm:upgrade'),
  onLlmUpgradeFailed: on('llm:upgrade-failed'),
  onLlmStopped: on('llm:stopped'),
  onLlmError: on('llm:error')
});

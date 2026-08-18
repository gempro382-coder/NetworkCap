'use strict';

const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  desktopCapturer,
  nativeImage,
  session
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');

const {
  APP_NAME,
  APP_ID,
  PATHS,
  OVERLAY_SIZE,
  BOOT_SIZE,
  SHORTCUTS,
  RENDERER_ONLY_SHORTCUTS,
  prettyAccel,
  GEMINI_PRIMARY_MODEL,
  SCREENSHOT_MODES,
  GROQ_MODELS,
  LLM_TIERS
} = require('./shared/constants');
const { createLogger, ensureDirs } = require('./shared/logger');
const { config } = require('./core/config-store');
const { shouldRestoreFromHide } = require('./core/visibility-state');
const { geminiService } = require('./services/gemini.service');
const { GroqSttService } = require('./services/groq-stt.service');
const { llmRouter, isAbortError } = require('./services/llm-router.service');
const { stagingTray } = require('./services/staging-tray.service');
const { GeminiHealingAgent } = require('./core/gemini-healing-agent');

const log = createLogger('main');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.setAppUserModelId(APP_ID);
app.setName(APP_NAME);
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Cloud STT + LLM services (no local models).
const groqStt = new GroqSttService(config.get('groqApiKey') || '');

let mainWindow = null;
let clickThrough = false;
let overlayVisible = true;
let inOverlayMode = false;
let suppressRestoreOnHide = false;
let healingAgent = null;
let persistenceInterval = null;
let micTestWaiter = null;
let recording = false;
let currentLlmModel = null;
let lastVisibilityToggleTs = 0;
const finishMicTest = (payload) => {
  send('mic-test-result', payload);
  if (micTestWaiter) { const w = micTestWaiter; micTestWaiter = null; w(payload); }
};

ensureDirs();

// ---------------------------------------------------------------------------
// Window — persistent overlay that never disappears.
// ---------------------------------------------------------------------------
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();

  mainWindow = new BrowserWindow({
    width: BOOT_SIZE.width,
    height: BOOT_SIZE.height,
    x: Math.round(workArea.x + (workArea.width - BOOT_SIZE.width) / 2),
    y: Math.round(workArea.y + (workArea.height - BOOT_SIZE.height) / 2),
    type: 'toolbar',
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    alwaysOnTop: false,
    backgroundColor: '#00000000',
    hasShadow: true,
    show: false,
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    try { mainWindow.setContentProtection(true); } catch (_) { }
    mainWindow.show();
  });

  mainWindow.on('hide', () => {
    if (inOverlayMode && shouldRestoreFromHide({ inOverlayMode, suppressRestoreOnHide, overlayVisible })) {
      log.warn('Window hidden externally - forcing show');
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed() && inOverlayMode && shouldRestoreFromHide({ inOverlayMode, suppressRestoreOnHide, overlayVisible })) {
          mainWindow.show();
          enforceOverlayPersistence();
        }
      }, 50);
    }
  });

  mainWindow.on('minimize', () => {
    if (inOverlayMode) {
      log.warn('Window minimized externally - restoring');
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.restore();
          mainWindow.show();
          enforceOverlayPersistence();
        }
      }, 50);
    }
  });

  mainWindow.on('blur', () => {
    if (inOverlayMode && mainWindow && !mainWindow.isDestroyed() && overlayVisible) {
      try {
        mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
        mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      } catch (_) { }
      try {
        const bypass = require('./services/win32-capture-bypass.service');
        bypass.forceTopmost(mainWindow);
      } catch (_) { }
    }
  });

  mainWindow.on('closed', () => {
    if (persistenceInterval) clearInterval(persistenceInterval);
    mainWindow = null;
  });

  // Local fallback for Show/Hide Overlay: if the OS (or another app) owns
  // Ctrl+Shift+H, globalShortcut silently fails to register it. This hook
  // still catches Ctrl/Cmd+Shift+H (and the Ctrl/Cmd+Alt+H alternate) while
  // the NetworkCap window is focused, so the toggle keeps working.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (!input.control && !input.meta) return;
    const key = String(input.key || '').toLowerCase();

    // Show/Hide Overlay fallback.
    if (key === 'h') {
      const isPrimaryToggle = input.shift && !input.alt;
      const isAltToggle = input.alt && !input.shift;
      if (isPrimaryToggle || isAltToggle) {
        event.preventDefault();
        toggleVisibility();
      }
      return;
    }

    // Shortcuts-help fallbacks. Ctrl+Shift+/ ('?' on most layouts) closes the
    // help panel and Ctrl+Shift+L toggles/pins it, even when the global
    // accelerator could not be registered (OS/other app owns it).
    if (!input.shift) return;
    if (key === '/' || key === '?') {
      event.preventDefault();
      send('close-shortcuts', true);
    } else if (key === 'l') {
      event.preventDefault();
      send('show-shortcuts', true);
    }
  });

  return mainWindow;
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function enforceOverlayPersistence() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (!inOverlayMode) return false;
  // User intentionally hid the overlay (Ctrl+Shift+H / Ctrl+Alt+H) —
  // never force it back on screen. The watchdog and capture paths must
  // respect this; only toggleVisibility() may re-show it.
  if (!overlayVisible) return false;
  try {
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    try { mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) { }
    try { mainWindow.setContentProtection(true); } catch (_) { }
    try {
      const bypass = require('./services/win32-capture-bypass.service');
      const res = bypass.forceTopmost(mainWindow);
      if (res.ok) bypass.ensureVisible(mainWindow);
    } catch (_) { }
  } catch (e) {
    log.warn(`Persistence enforce failed: ${e.message}`);
  }
  return true;
}

function startPersistenceWatchdog() {
  if (persistenceInterval) clearInterval(persistenceInterval);
  persistenceInterval = setInterval(() => {
    if (inOverlayMode && overlayVisible) enforceOverlayPersistence();
  }, 300);
  persistenceInterval.unref?.();
  log.info('Persistence watchdog started (300ms)');
}

function stopPersistenceWatchdog() {
  if (persistenceInterval) {
    clearInterval(persistenceInterval);
    persistenceInterval = null;
  }
}

function enterOverlayMode() {
  if (!mainWindow) return { ok: false };
  const { workArea } = screen.getPrimaryDisplay();
  mainWindow.setResizable(true);
  mainWindow.setSize(OVERLAY_SIZE.width, OVERLAY_SIZE.height);
  mainWindow.setPosition(Math.round(workArea.x + (workArea.width - OVERLAY_SIZE.width) / 2), Math.round(workArea.y + 8));
  mainWindow.setResizable(false);
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  try { mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) { }
  mainWindow.setSkipTaskbar(true);
  mainWindow.setOpacity(config.get('opacity') ?? 1.0);
  try { mainWindow.setContentProtection(true); } catch (_) { }
  try {
    const bypass = require('./services/win32-capture-bypass.service');
    bypass.forceTopmost(mainWindow);
  } catch (_) { }

  inOverlayMode = true;
  overlayVisible = true;
  startPersistenceWatchdog();
  log.info(`Overlay mode: ${OVERLAY_SIZE.width}x${OVERLAY_SIZE.height} with persistence watchdog`);
  return { ok: true, width: OVERLAY_SIZE.width, height: OVERLAY_SIZE.height };
}

function setOverlayOpacity(value, reason = 'manual', announce = false) {
  const bounded = Math.max(0.35, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : 1));
  const opacity = Math.round(bounded * 20) / 20;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setOpacity(opacity);
    try { mainWindow.setContentProtection(true); } catch (_) { }
  }
  config.set('opacity', opacity);
  send('opacity-changed', { value: opacity, percent: Math.round(opacity * 100) });
  if (announce) send('status-update', { message: `Overlay opacity: ${Math.round(opacity * 100)}%` });
  return opacity;
}

function adjustOverlayOpacity(delta) {
  const current = Number(config.get('opacity'));
  return setOverlayOpacity((Number.isFinite(current) ? current : 1) + delta, 'shortcut', true);
}

function resetWindow() {
  if (!mainWindow) return;
  const { workArea } = screen.getPrimaryDisplay();
  const [w] = mainWindow.getSize();
  mainWindow.setPosition(Math.round(workArea.x + (workArea.width - w) / 2), Math.round(workArea.y + 8));
  setOverlayOpacity(1.0, 'window-reset');
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  mainWindow.setIgnoreMouseEvents(false);
  clickThrough = false;
  config.set('clickThrough', false);
  if (!mainWindow.isVisible()) mainWindow.show();
  overlayVisible = true;
  enforceOverlayPersistence();
  send('click-through-state', false);
  send('status-update', { message: 'Window reset — top-center, 100% opacity' });
}

function setClickThrough(enabled) {
  if (!mainWindow) return false;
  clickThrough = enabled;
  mainWindow.setIgnoreMouseEvents(enabled, { forward: true });
  config.set('clickThrough', enabled);
  send('click-through-state', enabled);
  return enabled;
}

function toggleVisibility() {
  if (!mainWindow) return;
  // Debounce: globalShortcut, before-input-event and IPC can all deliver the
  // same physical keypress. Guarding prevents an instant hide+show double toggle.
  const now = Date.now();
  if (now - lastVisibilityToggleTs < 250) return;
  lastVisibilityToggleTs = now;
  if (mainWindow.isVisible()) {
    suppressRestoreOnHide = true;
    mainWindow.hide();
    overlayVisible = false;
  } else {
    suppressRestoreOnHide = false;
    mainWindow.show();
    mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    overlayVisible = true;
    enforceOverlayPersistence();
  }
}

// ---------------------------------------------------------------------------
// Screen capture — single ultra-fast mode (full screen, highest quality).
// Old "Hard" mode is gone; legacy config values map to 'normal'.
// ---------------------------------------------------------------------------
async function hardCaptureAll(requestedMode = null) {
  void requestedMode; // only one mode exists now: 'normal'

  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();

  // Highest quality: request thumbnails at each display's FULL physical
  // resolution (scaleFactor-aware) — no downscaling at all.
  const maxW = Math.max(...displays.map((d) => Math.round(d.size.width * (d.scaleFactor || 1))), 1920);
  const maxH = Math.max(...displays.map((d) => Math.round(d.size.height * (d.scaleFactor || 1))), 1080);

  // Fast path: capture screens (typically 1–2 sources) instead of enumerating
  // every open window — this is what makes it ultra fast.
  const screenSources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: maxW, height: maxH }
  });

  const shots = [];
  for (const src of screenSources) {
    if (!src.thumbnail || src.thumbnail.isEmpty()) continue;
    let img = src.thumbnail;
    // Trim the NetworkCap overlay pill (top-center, ~36px tall) out of the PRIMARY
    // display capture so screenshots stay clean. Never crop hidden/disabled.
    if (inOverlayMode && overlayVisible && mainWindow && !mainWindow.isDestroyed() &&
        String(src.display_id) === String(primary.id)) {
      try {
        const sz = img.getSize();
        const scale = primary.scaleFactor || 1;
        const strip = Math.min(Math.ceil((8 + 36 + 8) * scale), Math.floor(sz.height * 0.15));
        if (sz.height > strip + 120) {
          img = img.crop({ x: 0, y: strip, width: sz.width, height: sz.height - strip });
        }
      } catch (_) { /* keep full image if cropping fails */ }
    }
    const sz = img.getSize();
    shots.push({
      id: `screen-${src.id}`,
      sourceId: src.id,
      name: src.name,
      label: src.name || 'Screen',
      width: sz.width,
      height: sz.height,
      buffer: img.toPNG(),
      mimeType: 'image/png',
      kind: 'screen'
    });
  }

  if (!shots.length) {
    // Fallback: capture the largest non-NetworkCap window at full quality.
    const windowSources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: maxW, height: maxH },
      fetchWindowIcons: false
    });
    const filtered = windowSources.filter((s) => {
      const name = (s.name || '').toLowerCase();
      if (name.includes('networkcap')) return false;
      if (!s.thumbnail || s.thumbnail.isEmpty()) return false;
      const sz = s.thumbnail.getSize();
      return sz.width >= 300 && sz.height >= 200;
    }).sort((a, b) => {
      const sa = a.thumbnail.getSize(); const sb = b.thumbnail.getSize();
      return sb.width * sb.height - sa.width * sa.height;
    });
    if (filtered.length) {
      const src = filtered[0];
      const sz = src.thumbnail.getSize();
      shots.push({
        id: `window-${src.id}`,
        sourceId: src.id,
        name: src.name,
        label: `${src.name} (Fallback)`,
        width: sz.width,
        height: sz.height,
        buffer: src.thumbnail.toPNG(),
        mimeType: 'image/png',
        kind: 'window'
      });
    }
  }

  if (!shots.length) throw new Error('No capturable content. Try running as Administrator and keep a window open.');
  log.info(`Capture [normal] total: ${shots.length} shot(s) up to ${maxW}x${maxH}`);
  return { shots, mode: 'normal', screenCount: shots.filter((s) => s.kind === 'screen').length, windowCount: shots.filter((s) => s.kind === 'window').length, psCount: 0 };
}

async function captureScreen() {
  const { shots } = await hardCaptureAll();
  return shots[0];
}

function cycleScreenshotMode() {
  // Single-mode: always Normal (ultra-fast, full resolution).
  config.set('screenshotMode', SCREENSHOT_MODES.normal);
  send('status-update', { message: 'Screenshot mode: Normal — ultra-fast, full resolution' });
  return SCREENSHOT_MODES.normal;
}

// ---------------------------------------------------------------------------
// Privileges + Terminal
// ---------------------------------------------------------------------------
let cachedElevated = null;
function isElevated() {
  if (cachedElevated !== null) return cachedElevated;
  try {
    if (process.platform === 'win32') {
      execSync('net session', { stdio: 'ignore', timeout: 2500 });
      cachedElevated = true;
    } else if (typeof process.getuid === 'function') {
      cachedElevated = process.getuid() === 0;
    } else cachedElevated = false;
  } catch (_) { cachedElevated = false; }
  return cachedElevated;
}

function relaunchAsAdmin() {
  try {
    if (process.platform === 'win32') {
      const exe = process.execPath.replace(/'/g, "''");
      const command = app.isPackaged ? `Start-Process -FilePath '${exe}' -Verb RunAs` : `Start-Process -FilePath '${exe}' -ArgumentList '${app.getAppPath().replace(/'/g, "''")}' -Verb RunAs`;
      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      const target = app.isPackaged ? process.execPath : `${process.execPath} '${app.getAppPath()}'`;
      const script = `do shell script "'${target.replace(/'/g, "\\'")}'" with administrator privileges`;
      spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
    } else {
      const args = app.isPackaged ? [process.execPath] : [process.execPath, app.getAppPath()];
      spawn('pkexec', args, { detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true };
  } catch (error) { return { ok: false, reason: error.message }; }
}

let terminalProc = null;
let terminalCwd = os.homedir();
function sendTerminalOutput(stream, data) { send('terminal-output', { stream, data: String(data) }); }
function sendTerminalExit(code) { send('terminal-exit', { code }); }

async function handleTerminalCommand(commandLine) {
  const raw = String(commandLine || '');
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'empty', spawned: false, cwd: terminalCwd };
  if (terminalProc) return { ok: false, reason: 'busy', spawned: false, cwd: terminalCwd };
  if (/^(exit|quit)\b/i.test(trimmed)) {
    sendTerminalOutput('sys', 'Use the × button or Ctrl+Shift+W to close NetworkCap.\r\n');
    return { ok: true, spawned: false, cwd: terminalCwd };
  }
  if (/^(cls|clear)\b/i.test(trimmed)) {
    send('terminal-clear', true);
    return { ok: true, spawned: false, cwd: terminalCwd };
  }
  const cdMatch = trimmed.match(/^cd(?:\s+\/d)?\s+(.+)$/i);
  if (cdMatch) {
    let target = cdMatch[1].trim().replace(/^["']|["']$/g, '');
    if (target === '~' || target.startsWith('~/')) target = path.join(os.homedir(), target === '~' ? '.' : target.slice(2));
    const resolved = path.isAbsolute(target) ? target : path.resolve(terminalCwd, target);
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) terminalCwd = resolved;
      else sendTerminalOutput('err', `cd: no such directory: ${target}\r\n`);
    } catch (e) { sendTerminalOutput('err', `cd: ${e.message}\r\n`); }
    return { ok: true, spawned: false, cwd: terminalCwd };
  }
  const isWin = process.platform === 'win32';
  const shell = isWin ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/sh');
  const args = isWin ? ['/d', '/s', '/c', raw] : ['-c', raw];
  let proc;
  try { proc = spawn(shell, args, { cwd: terminalCwd, env: process.env, windowsHide: true }); } catch (error) {
    return { ok: false, reason: error.message, spawned: false, cwd: terminalCwd };
  }
  terminalProc = proc;
  proc.stdout.on('data', (d) => sendTerminalOutput('out', d));
  proc.stderr.on('data', (d) => sendTerminalOutput('err', d));
  proc.on('error', (err) => sendTerminalOutput('err', `\r\n${err.message}\r\n`));
  proc.on('close', (code) => { terminalProc = null; sendTerminalExit(code); });
  return { ok: true, spawned: true, cwd: terminalCwd };
}

// ---------------------------------------------------------------------------
// Voice recording (browser mic) + Groq Whisper STT
// ---------------------------------------------------------------------------
function toggleRecordingAndSend() {
  recording = !recording;
  send('recording-state', recording);
  if (!recording) {
    // Renderer stops the mic and sends the audio buffer via stt:transcribe.
    send('status-update', { message: 'Finishing transcription…' });
  } else {
    send('status-update', { message: 'Recording — listening' });
  }
  return { ok: true, recording };
}

function toBytes(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (input && input.type === 'Buffer' && Array.isArray(input.data)) return Buffer.from(input.data);
  if (typeof input === 'string') return Buffer.from(input, 'base64');
  return Buffer.from(input || []);
}

// ---------------------------------------------------------------------------
// LLM routing (3-tier) + live streaming to the renderer
// ---------------------------------------------------------------------------
async function runRouterStream({ query, images = [], forceTier = null, skill } = {}) {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const res = await llmRouter.dispatch({
      query,
      images,
      skill: skill || config.get('skill'),
      forceTier,
      requestId,
      onRouted: (r) => { currentLlmModel = r.model; send('llm:routed', r); },
      onFallback: (f) => { currentLlmModel = f.toModel; send('llm:fallback', f); },
      onChunk: (text) => send('llm:chunk', { text, done: false, model: currentLlmModel })
    });
    // Final guard: if every model somehow produced nothing, surface it as an
    // error instead of closing the stream on an empty bubble.
    if (!String(res.text || '').trim() && !res.upgradePending) {
      const reason = `${res.model || 'The model'} returned an empty answer. Try again or switch the tier model in Settings.`;
      log.error(`Router returned empty text (model=${res.model}, tier=${res.tier})`);
      send('llm:error', { error: reason });
      return { ok: false, reason };
    }
    send('llm:chunk', { text: '', done: true, model: res.model, upgradePending: Boolean(res.upgradePending), requestId });
    send('llm:tracker-update', {
      snapshot: llmRouter.tracker.getSnapshot(),
      classifierCalls: llmRouter.classifierCallsToday
    });
    return { ok: true, model: res.model, tier: res.tier };
  } catch (err) {
    log.error('Router stream failed:', err.message);
    // User-initiated stops already announce via 'llm:stopped' — don't also
    // surface them as an error.
    if (!isAbortError(err)) send('llm:error', { error: err.message });
    return { ok: false, reason: err.message };
  }
}

// Tier-3 fast path events (registered once): a fast partner streams the first
// answer, then the configured Tier-3 default model replaces it via 'llm:upgrade'.
// The upgrade can finish AFTER runRouterStream resolves, so these stay attached
// for the app's lifetime; the renderer matches events by requestId.
function forwardRouterUpgradeEvents() {
  llmRouter.on('fast-start', (f) => send('llm:fast-start', f));
  llmRouter.on('upgraded', (u) => send('llm:upgrade', u));
  llmRouter.on('upgrade-failed', (e) => send('llm:upgrade-failed', e));
}

async function stageCurrentScreen() {
  try {
    send('status-update', { message: 'Capturing…' });
    const { shots } = await hardCaptureAll();
    for (const shot of shots) {
      try { stagingTray.add(shot, { label: shot.label }); } catch (_) { }
    }
    send('staged-images-updated', stagingTray.toRendererState());
    const summary = `Captured ${shots.length} (full screen, full resolution).`;
    send('status-update', { message: summary });
    return { ok: true, count: stagingTray.count, shots: shots.length };
  } catch (err) {
    log.error('Stage failed:', err.message);
    send('status-update', { message: `Stage failed: ${err.message}` });
    return { ok: false, reason: err.message };
  }
}

// ---------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------
function shortcutBindings() {
  return [
    [SHORTCUTS.toggleRecording, 'Start/Stop Recording & Send', () => toggleRecordingAndSend()],
    [SHORTCUTS.stageImage, 'Stage Image', () => stageCurrentScreen()],
    [SHORTCUTS.sendStaged, 'Send Staged Images', () => {
      if (stagingTray.isEmpty()) { send('status-update', { message: 'Staging tray is empty.' }); return; }
      const images = stagingTray.toGeminiPayload();
      const n = images.length;
      stagingTray.clear();
      send('staged-images-updated', stagingTray.toRendererState());
      send('status-update', { message: `Sending ${n} staged image(s) to Gemini Vision (Tier 3)…` });
      runRouterStream({ query: 'Answer the question / solve the problem shown in the attached screenshot(s). If there are several, handle them in order.', images, forceTier: 3 });
    }],
    [SHORTCUTS.toggleClickThrough, 'Toggle Click-Through', () => setClickThrough(!clickThrough)],
    [SHORTCUTS.toggleVisibility, 'Show/Hide Overlay', () => toggleVisibility()],
    [SHORTCUTS.toggleVisibilityAlt, 'Show/Hide Overlay (Alt)', () => toggleVisibility()],
    [SHORTCUTS.resetWindow, 'Reset Window', () => resetWindow()],
    [SHORTCUTS.opacityUp, 'Increase Opacity', () => adjustOverlayOpacity(0.05)],
    [SHORTCUTS.opacityDown, 'Decrease Opacity', () => adjustOverlayOpacity(-0.05)],
    [SHORTCUTS.toggleTerminal, 'Toggle Terminal', () => send('terminal-toggle', true)],
    [SHORTCUTS.quit, 'Immediate Quit', () => hardQuit()],
    [SHORTCUTS.clearLastStaged, 'Clear Last Staged Photo', () => {
      const removed = stagingTray.removeLast();
      if (removed) {
        send('staged-images-updated', stagingTray.toRendererState());
        send('status-update', { message: `Removed last staged: ${removed.label}` });
      } else {
        send('status-update', { message: 'No staged images to clear.' });
      }
    }],
    [SHORTCUTS.stopAI, 'Stop AI Response', () => stopAiResponse()],
    [SHORTCUTS.showShortcuts, 'Show/Pin All Shortcuts Help', () => send('show-shortcuts', true)],
    [SHORTCUTS.closeShortcuts, 'Close Shortcuts Help', () => send('close-shortcuts', true)],
    [SHORTCUTS.closeShortcutsAlt, 'Close Shortcuts Help (alt)', () => send('close-shortcuts', true)],
    [SHORTCUTS.closeResponse, 'Close Response Overlay', () => send('close-response-overlay', true)]
  ];
}

/** Flat, display-ready shortcut list for the in-app help panel. */
function shortcutHelpList() {
  // Accelerators that are registered but shown merged into another row.
  const hidden = new Set([SHORTCUTS.closeShortcutsAlt]);
  const displayOverride = {
    [SHORTCUTS.closeShortcuts]: 'Ctrl+Shift+/  (or ?)'
  };
  const seen = new Set();
  const list = [];
  for (const [accel, label] of shortcutBindings()) {
    if (hidden.has(accel)) continue;
    const pretty = displayOverride[accel] || prettyAccel(accel);
    if (seen.has(pretty)) continue;
    seen.add(pretty);
    list.push({ accel: pretty, label, registered: isAcceleratorLive(accel) });
  }
  for (const extra of RENDERER_ONLY_SHORTCUTS) {
    list.push({ accel: extra.accel, label: extra.label, registered: true });
  }
  return list;
}

function isAcceleratorLive(accel) {
  try { return globalShortcut.isRegistered(accel); } catch (_) { return false; }
}

function registerShortcuts() {
  const bindings = shortcutBindings();
  // Register each accelerator; verify it actually took. globalShortcut silently
  // fails when the OS or another app already owns the combo, so re-try a few
  // times (AV/IME tools sometimes grab hotkeys briefly at startup) and warn.
  for (const [accel, label, handler] of bindings) {
    (function attempt(remaining) {
      let ok = false;
      try {
        ok = globalShortcut.register(accel, handler) && globalShortcut.isRegistered(accel);
      } catch (err) {
        log.warn(`Failed to register ${accel}: ${err.message}`);
      }
      if (!ok && remaining > 1) {
        log.info(`✗ ${accel} → ${label} (retrying ${remaining - 1}x)`);
        setTimeout(() => attempt(remaining - 1), 1200);
        return;
      }
      log.info(`${ok ? '✓' : '✗'} ${accel} → ${label}`);
      if (!ok && (accel === SHORTCUTS.toggleVisibility || accel === SHORTCUTS.toggleVisibilityAlt)) {
        log.warn(`${label} (${accel}) unavailable — owned by the OS or another app. Ctrl+Shift+H still works while NetworkCap is focused (in-window fallback).`);
        send('status-update', { message: `⚠ ${accel} is taken by another app — Show/Hide Overlay still works via the alternate hotkey or while NetworkCap is focused.` });
      }
    })(3);
  }
}

// Hard-stop any in-flight AI generation (Groq fast/tier calls + Gemini calls).
function stopAiResponse() {
  llmRouter.cancel();
  send('llm:stopped', {});
  send('status-update', { message: 'AI response stopped.' });
}

function hardQuit() {
  stopPersistenceWatchdog();
  log.info('Immediate quit requested');
  try { globalShortcut.unregisterAll(); } catch (_) { }
  app.exit(0);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('get-boot-status', () => ({
    app: APP_NAME,
    version: app.getVersion(),
    dataDir: PATHS.root,
    groq: groqStt.status(),
    gemini: geminiService.status(),
    sttTracker: groqStt.tracker.getSnapshot(),
    llmTracker: llmRouter.tracker.getSnapshot(),
    classifierCalls: llmRouter.classifierCallsToday,
    availableModels: geminiService.availableModels(),
    groqModels: GROQ_MODELS,
    primaryModel: GEMINI_PRIMARY_MODEL,
    platform: process.platform,
    elevated: isElevated(),
    screenshotMode: config.get('screenshotMode') || 'normal',
    fastAnswerModel: config.get('fastAnswerModel'),
    tierOverrides: config.get('tierOverrides') || {},
    tierDefaults: {
      simple: { primary: LLM_TIERS.simple.primary.id, fallback: LLM_TIERS.simple.fallback.id, extras: (LLM_TIERS.simple.extraFallbacks || []).map((m) => m.id) },
      moderate: { primary: LLM_TIERS.moderate.primary.id, fallback: LLM_TIERS.moderate.fallback.id, extras: (LLM_TIERS.moderate.extraFallbacks || []).map((m) => m.id) },
      hard: { primary: LLM_TIERS.hard.primary.id, fallback: LLM_TIERS.hard.fallback.id, extras: (LLM_TIERS.hard.extraFallbacks || []).map((m) => m.id) }
    }
  }));

  ipcMain.handle('get-available-models', () => ({
    gemini: geminiService.availableModels(),
    groq: GROQ_MODELS,
    catalog: config.get('geminiModelCatalog') || [],
    catalogUpdatedAt: config.get('geminiCatalogUpdatedAt') || 0,
    tierOverrides: config.get('tierOverrides') || {},
    fastAnswerModel: config.get('fastAnswerModel'),
    tierDefaults: {
      simple: { primary: LLM_TIERS.simple.primary.id, fallback: LLM_TIERS.simple.fallback.id, extras: (LLM_TIERS.simple.extraFallbacks || []).map((m) => m.id) },
      moderate: { primary: LLM_TIERS.moderate.primary.id, fallback: LLM_TIERS.moderate.fallback.id, extras: (LLM_TIERS.moderate.extraFallbacks || []).map((m) => m.id) },
      hard: { primary: LLM_TIERS.hard.primary.id, fallback: LLM_TIERS.hard.fallback.id, extras: (LLM_TIERS.hard.extraFallbacks || []).map((m) => m.id) }
    }
  }));

  ipcMain.handle('refresh-gemini-models', () => geminiService.refreshModelCatalog());

  ipcMain.handle('verify-environment', async () => {
    const report = { steps: [] };
    const step = (name, ok, detail, optional = false) => {
      report.steps.push({ name, ok, detail, optional });
      send('boot-progress', { name, ok, detail, optional });
    };

    step('App data directory', fs.existsSync(PATHS.root), PATHS.root);

    const groqKey = config.get('groqApiKey');
    step('Groq API key', Boolean(groqKey), groqKey ? `configured (…${groqKey.slice(-4)})` : 'missing — set it below');

    const geminiKey = config.get('geminiApiKey');
    step('Gemini API key', Boolean(geminiKey), geminiKey ? `configured (…${geminiKey.slice(-4)})` : 'missing — set it below');

    if (geminiKey) {
      geminiService.configure(geminiKey);
      const v = await geminiService.verify();
      step('Gemini connectivity', v.ok, v.ok ? `${v.model} via ${v.transport}` : v.reason);
    } else {
      step('Gemini connectivity', false, 'add a Gemini key to verify', true);
    }

    if (groqKey) {
      groqStt.setApiKey(groqKey);
      step('Groq STT ready', true, `Whisper ${groqStt.primaryModel} · fallback ${groqStt.fallbackModel}`);
    } else {
      step('Groq STT ready', false, 'add a Groq key to enable voice', true);
    }

    try {
      const bypass = require('./services/win32-capture-bypass.service');
      const api = bypass.loadApi();
      if (api) step('Koffi Win32 bypass + persistence', true, 'koffi loaded - hard unprotect & topmost available');
      else step('Koffi Win32 bypass', true, 'koffi not available - fallback still works', true);
    } catch (e) {
      step('Koffi Win32 bypass', false, `Load failed: ${e.message}`, true);
    }

    try {
      const ps = require('./services/win32-ps-capture.service');
      step('PowerShell GDI capture', true, 'PS fallback available - captures test when desktopCapturer fails');
    } catch (e) {
      step('PowerShell GDI capture', true, `Optional: ${e.message}`, true);
    }

    step('Browser microphone capture', true, 'getUserMedia → 16 kHz mono WAV → Groq Whisper API (click "Mic test" to verify)');

    const smode = config.get('screenshotMode') || 'normal';
    step('Screenshot mode', true, `Mode: ${smode} — ultra-fast, full screen, full resolution`);

    report.ok = report.steps.filter((s) => !s.optional).every((s) => s.ok);
    return report;
  });

  ipcMain.handle('start-aashi', () => enterOverlayMode());

  ipcMain.handle('run-mic-test', async (_e, seconds) => {
    const secs = Math.max(1, Math.min(15, Number(seconds) || 4));
    if (!config.get('groqApiKey')) {
      return { ok: false, reason: 'Groq API key is required for transcription' };
    }
    if (micTestWaiter) return { ok: false, reason: 'a mic test is already running' };
    send('status-update', { message: `Mic test — say a full sentence for ${secs}s…` });
    send('browser-mic-test-request', { seconds: secs });
    return new Promise((resolve) => {
      micTestWaiter = resolve;
      setTimeout(() => {
        if (micTestWaiter === resolve) finishMicTest({ ok: false, reason: `no audio came back from the renderer within ${secs + 12}s` });
      }, (secs + 12) * 1000);
    });
  });

  ipcMain.handle('mic-test-audio', (_e, payload = {}) => {
    const buf = toBytes(payload.pcm);
    const dur = Number(payload.durationSec) || 0;
    if (!buf.length) { finishMicTest({ ok: false, reason: 'the renderer captured 0 samples' }); return { ok: false }; }
    (async () => {
      try {
        const result = await groqStt.transcribe(buf, dur);
        if (!result || !result.text) finishMicTest({ ok: false, verify_reason: 'No speech was recognized.', transcript: '' });
        else finishMicTest({ ok: true, transcript: result.text });
      } catch (e) {
        finishMicTest({ ok: false, reason: e.message });
      }
    })();
    return { ok: true };
  });

  ipcMain.handle('get-config', () => {
    const c = { ...config.get() };
    if (c.geminiApiKey) { c.geminiApiKeyMasked = `…${c.geminiApiKey.slice(-4)}`; delete c.geminiApiKey; }
    if (c.groqApiKey) { c.groqApiKeyMasked = `…${c.groqApiKey.slice(-4)}`; delete c.groqApiKey; }
    return c;
  });

  ipcMain.handle('set-config', (_e, patch) => {
    if (patch && typeof patch === 'object') {
      const safe = { ...patch };
      // Only the single screenshot mode exists — clamp any legacy value.
      if (safe.screenshotMode != null) safe.screenshotMode = SCREENSHOT_MODES.normal;
      config.set(safe);
      if (safe.geminiApiKey) geminiService.configure(safe.geminiApiKey);
      if (safe.groqApiKey) groqStt.setApiKey(safe.groqApiKey);
      if (safe.sttModel) groqStt.setModel(safe.sttModel);
      if (safe.model) geminiService.selectModel(safe.model);
      if (safe.opacity != null) setOverlayOpacity(safe.opacity, 'config');
      if (safe.fastAnswerModel) llmRouter.tracker.ensureModel(String(safe.fastAnswerModel), { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 });
      const tov = safe.tierOverrides;
      if (tov && typeof tov === 'object') {
        for (const [k, pair] of Object.entries(tov)) {
          if (pair && typeof pair === 'object') {
            if (pair.primary) llmRouter.tracker.ensureModel(String(pair.primary), LLM_TIERS[k]?.primary || {});
            if (pair.fallback) llmRouter.tracker.ensureModel(String(pair.fallback), LLM_TIERS[k]?.fallback || {});
          }
        }
      }
    }
    return { ok: true, model: config.get('model'), qualityMode: config.get('qualityMode') };
  });

  ipcMain.handle('toggle-recording', () => toggleRecordingAndSend());

  // STT: renderer sends recorded audio, main transcribes via Groq Whisper.
  ipcMain.handle('stt:transcribe', async (_e, payload = {}) => {
    const buf = toBytes(payload.audioBuffer);
    const dur = Number(payload.durationSec) || 0;
    try {
      const result = await groqStt.transcribe(buf, dur);
      if (result && result.skipped) { send('status-update', { message: 'Audio too short — speak a little longer.' }); return { ok: false, skipped: true }; }
      if (!result) { send('status-update', { message: '🔴 STT paused — rate limit. Resuming soon…' }); return { ok: false, rateLimited: true }; }
      send('stt:result', { text: result.text, model: result.model, latencyMs: result.latencyMs });
      return { ok: true, text: result.text, model: result.model };
    } catch (err) {
      log.error('STT failed:', err.message);
      send('status-update', { message: `STT error: ${err.message}` });
      return { ok: false, error: err.message };
    }
  });

  // LLM: renderer sends a question (optionally with staged images), main routes.
  ipcMain.handle('llm:ask', (_e, payload = {}) => {
    const query = String(payload.query || '').trim();
    if (!query) return { ok: false, reason: 'empty' };
    const images = Array.isArray(payload.images) ? payload.images : [];
    const forceTier = payload.forceTier != null ? Number(payload.forceTier) : null;
    return runRouterStream({ query, images, forceTier, skill: payload.skill });
  });

  ipcMain.handle('stage-screenshot', () => stageCurrentScreen());
  ipcMain.handle('send-staged-images', (_e, args) => {
    if (stagingTray.isEmpty()) { send('status-update', { message: 'Staging tray is empty.' }); return { ok: false, reason: 'empty' }; }
    const images = stagingTray.toGeminiPayload();
    const n = images.length;
    stagingTray.clear();
    send('staged-images-updated', stagingTray.toRendererState());
    send('status-update', { message: `Sending ${n} staged image(s) to Gemini Vision (Tier 3)…` });
    return runRouterStream({
      query: 'Answer the question / solve the problem shown in the attached screenshot(s). If there are several, handle them in order.',
      images, forceTier: 3, skill: args && args.skill
    });
  });
  ipcMain.handle('clear-staged-images', () => { const n = stagingTray.clear(); send('staged-images-updated', stagingTray.toRendererState()); return { ok: true, cleared: n }; });
  ipcMain.handle('remove-staged-image', (_e, id) => { const ok = stagingTray.remove(id); send('staged-images-updated', stagingTray.toRendererState()); return { ok }; });
  ipcMain.handle('get-staged-images', () => stagingTray.toRendererState());
  ipcMain.handle('remove-last-staged-image', () => {
    const removed = stagingTray.removeLast();
    if (removed) send('staged-images-updated', stagingTray.toRendererState());
    return { ok: !!removed, removed };
  });
  ipcMain.handle('capture-and-send', async (_e, { skill } = {}) => {
    try {
      const { shots } = await hardCaptureAll();
      const images = shots.map((s) => ({ buffer: Buffer.isBuffer(s.buffer) ? s.buffer : Buffer.from(s.buffer), mimeType: s.mimeType || 'image/png' }));
      if (!images.length) { send('status-update', { message: 'No screenshot captured.' }); return { ok: false, reason: 'no-capture' }; }
      send('status-update', { message: `Sending ${images.length} capture(s) to Gemini Vision (Tier 3)…` });
      return runRouterStream({
        query: 'Answer the question / solve the problem shown in the attached screenshot(s). If there are several, handle them in order.',
        images, forceTier: 3, skill
      });
    } catch (err) { send('response-error', { error: err.message }); return { ok: false, reason: err.message }; }
  });

  ipcMain.handle('get-screenshot-mode', () => config.get('screenshotMode') || 'hard');
  ipcMain.handle('set-screenshot-mode', (_e, mode) => {
    if (!Object.values(SCREENSHOT_MODES).includes(mode)) return { ok: false, reason: 'invalid mode' };
    config.set('screenshotMode', mode);
    send('screenshot-mode-changed', { mode });
    return { ok: true, mode };
  });
  ipcMain.handle('cycle-screenshot-mode', () => { const next = cycleScreenshotMode(); return { ok: true, mode: next }; });

  ipcMain.handle('is-admin', () => ({ elevated: isElevated(), platform: process.platform }));
  ipcMain.handle('relaunch-as-admin', () => {
    const result = relaunchAsAdmin();
    if (result.ok) { send('status-update', { message: 'Relaunching as Administrator…' }); setTimeout(() => app.quit(), 600); }
    return result;
  });
  ipcMain.handle('terminal-exec', (_e, commandLine) => handleTerminalCommand(commandLine));
  ipcMain.handle('terminal-input', (_e, data) => {
    if (!terminalProc || !terminalProc.stdin || !terminalProc.stdin.writable) return { ok: false, reason: 'No command is waiting for input.' };
    try { terminalProc.stdin.write(String(data || '')); return { ok: true }; } catch (error) { return { ok: false, reason: error.message }; }
  });
  ipcMain.handle('terminal-kill', () => {
    if (!terminalProc) return { ok: false, reason: 'Nothing is running.' };
    try { terminalProc.kill(); return { ok: true }; } catch (error) { return { ok: false, reason: error.message }; }
  });
  ipcMain.handle('terminal-status', () => ({ running: Boolean(terminalProc), cwd: terminalCwd }));

  // Live shortcut map for the "All Shortcuts" help panel — always in sync with
  // what is actually registered, so the panel can never drift from reality.
  ipcMain.handle('get-shortcuts', () => shortcutHelpList());

  ipcMain.handle('toggle-click-through', () => setClickThrough(!clickThrough));
  ipcMain.handle('toggle-visibility', () => (toggleVisibility(), overlayVisible));
  ipcMain.handle('reset-window', () => (resetWindow(), true));
  ipcMain.handle('set-opacity', (_e, value) => setOverlayOpacity(value, 'ipc'));
  ipcMain.handle('resize-overlay', (_e, height) => {
    if (!mainWindow || !inOverlayMode) return false;
    const h = Math.max(OVERLAY_SIZE.height, Math.min(760, Math.round(height)));
    mainWindow.setResizable(true);
    mainWindow.setSize(OVERLAY_SIZE.width, h);
    mainWindow.setResizable(false);
    return true;
  });
  ipcMain.handle('quit-app', () => hardQuit());
  ipcMain.handle('stop-generation', () => { stopAiResponse(); return { ok: true }; });

  ipcMain.handle('run-healing', async (_e, message) => {
    const res = await healingAgent.heal(new Error(message || 'manual invocation'));
    send('healing-update', res);
    return res;
  });
  ipcMain.handle('get-healing-history', () => healingAgent.getHistory());
}

app.whenReady().then(async () => {
  log.info(`${APP_NAME} starting — data dir ${PATHS.root}`);
  healingAgent = new GeminiHealingAgent({ gemini: geminiService });
  const groqKey = config.get('groqApiKey');
  if (groqKey) groqStt.setApiKey(groqKey);
  const geminiKey = config.get('geminiApiKey');
  if (geminiKey) geminiService.configure(geminiKey);
  geminiService.selectModel(config.get('model'));

  createWindow();
  try {
    const ownRenderer = (wc) => Boolean(mainWindow && !mainWindow.isDestroyed() && wc?.id === mainWindow.webContents.id);
    session.defaultSession.setPermissionCheckHandler((wc, perm, _origin, details) => ownRenderer(wc) && perm === 'media' && !(details.mediaTypes || []).includes('video'));
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(ownRenderer(wc) && perm === 'media'));
  } catch (_) { }

  registerIpc();
  registerShortcuts();
  forwardRouterUpgradeEvents();

  // Forward live STT + LLM tracker snapshots to the renderer.
  groqStt.on('tracker-update', (snap) => send('stt:tracker-update', { snapshot: snap }));
  groqStt.on('rate-limited', ({ model, retryAfterMs }) => send('stt:rate-limited', { model, retryAfterMs }));

  send('boot-log', { message: 'Groq STT + 3-tier LLM router ready', level: 'info' });
});

app.on('second-instance', () => { if (mainWindow) { if (!mainWindow.isVisible()) mainWindow.show(); mainWindow.focus(); } });
app.on('window-all-closed', () => hardQuit());
app.on('will-quit', () => { stopPersistenceWatchdog(); globalShortcut.unregisterAll(); });
process.on('uncaughtException', async (err) => { log.error('Uncaught exception:', err); });
process.on('unhandledRejection', (reason) => { log.error('Unhandled rejection:', reason); });

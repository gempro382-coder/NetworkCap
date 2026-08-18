'use strict';

/**
 * Headless UI test for the shortcuts help panel (pin / peek / close).
 * Loads the real index.html + renderer.js in jsdom with a stubbed bridge.
 *
 *   npm i --no-save jsdom && node tests/shortcuts-help.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (_) {
  console.log('shortcuts-help: SKIPPED (jsdom not installed — run `npm i --no-save jsdom`)');
  process.exit(0);
}

const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const rendererJs = fs.readFileSync(path.join(rendererDir, 'renderer.js'), 'utf8');
const micJs = fs.readFileSync(path.join(rendererDir, 'mic-capture.js'), 'utf8');

const SHORTCUT_ROWS = [
  { accel: 'Ctrl+Shift+V', label: 'Start/Stop Recording & Send', registered: true },
  { accel: 'Ctrl+Shift+L', label: 'Show/Pin All Shortcuts Help', registered: true },
  { accel: 'Ctrl+Shift+/  (or ?)', label: 'Close Shortcuts Help', registered: true },
  { accel: 'Ctrl+Shift+H', label: 'Show/Hide Overlay', registered: false }
];

const listeners = {};
function makeApi() {
  const on = (name) => (cb) => { (listeners[name] = listeners[name] || []).push(cb); return () => {}; };
  return {
    appRoot: '/app',
    getShortcuts: async () => SHORTCUT_ROWS,
    getBootStatus: async () => ({ ready: true, geminiConfigured: true, groqConfigured: true }),
    getConfig: async () => ({ skill: 'interview', model: 'gemini-3.7-flash', opacity: 1 }),
    setConfig: async () => ({ ok: true }),
    getAvailableModels: async () => ({ gemini: [] }),
    getScreenshotMode: async () => 'normal',
    getStagedImages: async () => ({ count: 0, images: [] }),
    isAdmin: async () => ({ admin: false }),
    terminalStatus: async () => ({ running: false, cwd: '/' }),
    resizeOverlay: async () => true,
    verifyEnvironment: async () => ({ ok: true }),
    onShowShortcuts: on('showShortcuts'),
    onCloseShortcuts: on('closeShortcuts'),
    onShowOverlay: on('showOverlay')
  };
}

// Any other bridge method the renderer touches resolves to a harmless object.
const api = new Proxy(makeApi(), {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (typeof prop !== 'string') return undefined;
    if (prop.startsWith('on')) return (cb) => { (listeners[prop] = listeners[prop] || []).push(cb); return () => {}; };
    return async () => ({ ok: true });
  }
});

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
window.aashi = api;
window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
if (!window.navigator.mediaDevices) window.navigator.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [] }) };

window.eval(micJs);
window.eval(rendererJs);

const $ = (id) => window.document.getElementById(id);
const popover = $('shortcutsPopover');
const helpBtn = $('shortcutsHelpButton');
const isOpen = () => popover.classList.contains('open');
const isPinned = () => popover.classList.contains('pinned');
const fire = (name, payload) => (listeners[name] || []).forEach((cb) => cb(payload));
const mouse = (node, type) => node.dispatchEvent(new window.MouseEvent(type, { bubbles: false }));
const clickBtn = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const key = (init) => window.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, ...init }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const check = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };

(async () => {
  console.log('shortcuts help panel');
  await wait(60); // let the async shortcut list load

  await check('list is rendered from the live shortcut map', () => {
    const rows = $('shortcutsList').querySelectorAll('div');
    assert.strictEqual(rows.length, SHORTCUT_ROWS.length);
    assert.strictEqual(rows[0].querySelector('kbd').textContent, 'Ctrl+Shift+V');
    assert.ok(rows[2].querySelector('kbd').textContent.includes('Ctrl+Shift+/'));
    // A hotkey the OS stole is flagged, not silently wrong.
    assert.ok(rows[3].classList.contains('shortcut-dead'));
    assert.ok(/taken by another app/.test(rows[3].querySelector('span').textContent));
  });

  await check('hover peeks, mouse-out closes', async () => {
    mouse(helpBtn, 'mouseenter');
    assert.ok(isOpen() && !isPinned());
    mouse(helpBtn, 'mouseleave');
    await wait(320);
    assert.ok(!isOpen());
  });

  await check('pointer can travel from ? into the panel without it closing', async () => {
    mouse(helpBtn, 'mouseenter');
    mouse(helpBtn, 'mouseleave');
    await wait(80);
    mouse(popover, 'mouseenter');
    await wait(320);
    assert.ok(isOpen(), 'panel closed while the pointer was inside it');
    mouse(popover, 'mouseleave');
    await wait(320);
    assert.ok(!isOpen());
  });

  await check('clicking ? pins the panel open', () => {
    clickBtn(helpBtn);
    assert.ok(isOpen() && isPinned());
    assert.strictEqual(helpBtn.getAttribute('aria-pressed'), 'true');
    assert.ok($('shortcutsPinBadge').classList.contains('show'));
  });

  await check('pinned panel survives mouse-out', async () => {
    mouse(popover, 'mouseleave');
    await wait(320);
    assert.ok(isOpen(), 'pinned panel closed on mouse-out');
  });

  await check('pinned panel survives opening Settings and Usage', () => {
    clickBtn($('settingsButton'));
    assert.ok(isOpen(), 'pinned panel closed when Settings opened');
    clickBtn($('usageButton'));
    assert.ok(isOpen(), 'pinned panel closed when Usage opened');
  });

  await check('pinned panel survives an outside click', () => {
    $('statusLine').dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
    assert.ok(isOpen(), 'pinned panel closed on outside click');
  });

  await check('pinned panel survives Escape', () => {
    key({ key: 'Escape' });
    assert.ok(isOpen(), 'pinned panel closed on Escape');
  });

  await check('pinned panel survives overlay hide/show (Ctrl+Shift+H)', () => {
    fire('showOverlay', true);
    assert.ok(isOpen());
  });

  await check('Ctrl+Shift+/ closes and unpins it', () => {
    key({ key: '/', ctrlKey: true, shiftKey: true });
    assert.ok(!isOpen() && !isPinned());
    assert.strictEqual(helpBtn.getAttribute('aria-pressed'), 'false');
  });

  await check('Ctrl+Shift+? (main-process event) also closes it', () => {
    fire('showShortcuts', true);
    assert.ok(isOpen() && isPinned());
    fire('closeShortcuts', true);
    assert.ok(!isOpen() && !isPinned());
  });

  await check('Ctrl+Shift+L toggles pin on and off', () => {
    fire('showShortcuts', true);
    assert.ok(isOpen() && isPinned());
    fire('showShortcuts', true);
    assert.ok(!isOpen() && !isPinned());
  });

  await check('the × button closes a pinned panel', () => {
    clickBtn(helpBtn);
    assert.ok(isPinned());
    clickBtn($('shortcutsClose'));
    assert.ok(!isOpen() && !isPinned());
  });

  console.log(`\n${passed} checks passed.`);
  process.exit(0);
})().catch((err) => { console.error('\n✗ FAILED:', err.message); process.exit(1); });

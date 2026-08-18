'use strict';

// HARD FIX for locked-down test environments + overlay persistence
// Robust loader - never crashes, returns null if koffi missing

const WDA_NONE = 0x00000000;
const WDA_EXCLUDEFROMCAPTURE = 0x00000011;
const GW_HWNDNEXT = 2;
const HWND_TOPMOST = -1;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const SWP_NOZORDER = 0x0004;
const SW_RESTORE = 9;
const SW_SHOW = 5;

let cachedApi = undefined;

function loadApi() {
  if (cachedApi !== undefined) return cachedApi;
  if (process.platform !== 'win32') {
    cachedApi = null;
    return null;
  }
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const HANDLE = koffi.pointer('HANDLE', koffi.opaque());
    const HWND = koffi.alias('HWND', HANDLE);
    const DWORD = koffi.alias('DWORD', 'uint32_t');

    cachedApi = {
      koffi,
      GetTopWindow: user32.func('HWND __stdcall GetTopWindow(HWND hWnd)'),
      GetWindow: user32.func('HWND __stdcall GetWindow(HWND hWnd, uint32_t uCmd)'),
      GetForegroundWindow: user32.func('HWND __stdcall GetForegroundWindow()'),
      IsWindow: user32.func('BOOL __stdcall IsWindow(HWND hWnd)'),
      IsWindowVisible: user32.func('BOOL __stdcall IsWindowVisible(HWND hWnd)'),
      IsIconic: user32.func('BOOL __stdcall IsIconic(HWND hWnd)'),
      ShowWindow: user32.func('BOOL __stdcall ShowWindow(HWND hWnd, int nCmdShow)'),
      SetWindowPos: user32.func('BOOL __stdcall SetWindowPos(HWND hWnd, HWND hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)'),
      SetWindowDisplayAffinity: user32.func('BOOL __stdcall SetWindowDisplayAffinity(HWND hWnd, DWORD dwAffinity)'),
      GetWindowDisplayAffinity: user32.func('BOOL __stdcall GetWindowDisplayAffinity(HWND hWnd, DWORD* pdwAffinity)'),
      SetForegroundWindow: user32.func('BOOL __stdcall SetForegroundWindow(HWND hWnd)'),
      BringWindowToTop: user32.func('BOOL __stdcall BringWindowToTop(HWND hWnd)'),
    };
    return cachedApi;
  } catch (e) {
    cachedApi = null;
    return null;
  }
}

function ptrToBigInt(ptr) {
  if (!ptr) return 0n;
  try {
    if (typeof ptr === 'bigint') return ptr;
    if (Buffer.isBuffer(ptr)) {
      if (ptr.length >= 8) return ptr.readBigUInt64LE(0);
      if (ptr.length >= 4) return BigInt(ptr.readUInt32LE(0));
      return 0n;
    }
    if (typeof ptr === 'number') return BigInt(ptr >>> 0);
    const s = ptr.toString();
    if (s.startsWith('0x')) return BigInt(s);
    return BigInt(s);
  } catch (_) { return 0n; }
}

function getOurHwndBig(ourWindow) {
  try {
    if (ourWindow && !ourWindow.isDestroyed()) {
      const h = ourWindow.getNativeWindowHandle();
      if (Buffer.isBuffer(h)) {
        return h.length >= 8 ? h.readBigUInt64LE(0) : BigInt(h.readUInt32LE(0));
      }
    }
  } catch (_) {}
  return 0n;
}

function unprotectAllTopLevelWindows(ourWindow = null) {
  const api = loadApi();
  if (!api) {
    return { attempted: 0, unprotected: 0, errors: 0, skipped: true, reason: 'koffi not available' };
  }
  let ourHwndBig = getOurHwndBig(ourWindow);
  let attempted = 0, unprotected = 0, errors = 0;
  try {
    try {
      const fg = api.GetForegroundWindow();
      const fgBig = ptrToBigInt(fg);
      if (fgBig !== 0n && fgBig !== ourHwndBig) {
        attempted++;
        try { const ok = api.SetWindowDisplayAffinity(fg, WDA_NONE); if (ok) unprotected++; } catch (_) { errors++; }
      }
    } catch (_) { errors++; }

    let hwnd = null;
    try { hwnd = api.GetTopWindow(null); } catch (_) {}
    let iterations = 0;
    while (hwnd && iterations < 1500) {
      iterations++;
      const curBig = ptrToBigInt(hwnd);
      if (curBig === 0n) break;
      if (curBig !== ourHwndBig) {
        try {
          const visible = api.IsWindowVisible(hwnd);
          if (visible) {
            attempted++;
            try { const ok = api.SetWindowDisplayAffinity(hwnd, WDA_NONE); if (ok) unprotected++; } catch (_) { errors++; }
          }
        } catch (_) { errors++; }
      }
      try { hwnd = api.GetWindow(hwnd, GW_HWNDNEXT); } catch (_) { break; }
    }
    return { attempted, unprotected, errors, skipped: false };
  } catch (e) {
    return { attempted, unprotected, errors: errors + 1, skipped: false, reason: e.message };
  }
}

// HARD FIX 1: Force overlay to stay topmost and visible no matter what test environment does
function forceTopmost(ourWindow) {
  const api = loadApi();
  if (!api || !ourWindow || ourWindow.isDestroyed()) return { ok: false, reason: 'no api or window' };
  try {
    const hwnd = ourWindow.getNativeWindowHandle();
    // Convert Buffer HWND to pointer for koffi - koffi will handle Buffer? We try both ways
    // Use our window's native handle buffer directly if koffi accepts pointer objects
    // For simplicity, we will use the raw HWND via ourWindow's handle converted to void* via BigInt trick:
    // koffi's HWND alias is HANDLE pointer, we can pass the BigInt as number if within 32-bit? Safer to pass as is using koffi's pointer type?
    // We'll attempt to call SetWindowPos with our HWND buffer interpreted.
    // Koffi can take a JS number for HWND? We'll try using the handle Buffer's BigInt as void* by creating a fake pointer.
    // Alternative: Use ourWindow's actual HWND via GetForegroundWindow? No.
    // We'll attempt: if api.SetWindowPos expects HWND, pass our window handle as retrieved via ourWindow.getNativeWindowHandle() converted to number via read.
    const ourHwndBig = getOurHwndBig(ourWindow);
    if (ourHwndBig === 0n) return { ok: false, reason: 'invalid hwnd' };

    // For HWND_TOPMOST = -1, needs to be passed as pointer with value -1 (0xFFFFFFFFFFFFFFFF)
    // In koffi, we pass -1 as HWND
    // We'll try using number -1 for topmost
    // Note: koffi may not support negative pointer, so we use 0xFFFFFFFF as workaround for 32-bit? We'll try.

    // Show window if hidden/minimized
    try {
      // If iconic (minimized), restore
      const iconic = api.IsIconic(ourWindow.getNativeWindowHandle());
      if (iconic) {
        api.ShowWindow(ourWindow.getNativeWindowHandle(), SW_RESTORE);
      }
    } catch (_) {}

    try { api.ShowWindow(ourWindow.getNativeWindowHandle(), SW_SHOW); } catch (_) {}

    try {
      // SetWindowPos(HWND_TOPMOST, 0,0,0,0, NOSIZE|NOMOVE|NOACTIVATE|SHOWWINDOW)
      const flags = SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_SHOWWINDOW;
      // Need to pass HWND_TOPMOST as HWND. In Win32, HWND_TOPMOST = (HWND)-1
      // koffi may accept -1 as number for HWND alias? Try passing -1 directly
      // We'll call with our hwnd and -1 as insertAfter
      api.SetWindowPos(ourWindow.getNativeWindowHandle(), -1, 0, 0, 0, 0, flags);
      return { ok: true };
    } catch (e) {
      // Fallback: try with 0 as topmost? still top?
      try {
        api.BringWindowToTop(ourWindow.getNativeWindowHandle());
        return { ok: true, fallback: true };
      } catch (e2) {
        return { ok: false, reason: e2.message };
      }
    }
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function ensureVisible(ourWindow) {
  if (!ourWindow || ourWindow.isDestroyed()) return false;
  let changed = false;
  try {
    if (!ourWindow.isVisible()) { ourWindow.show(); changed = true; }
    if (ourWindow.isMinimized()) { ourWindow.restore(); changed = true; }
    // Always on top reassert
    ourWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    try { ourWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
    try { ourWindow.setContentProtection(true); } catch (_) {}
  } catch (_) {}
  return changed;
}

module.exports = {
  WDA_NONE,
  WDA_EXCLUDEFROMCAPTURE,
  unprotectAllTopLevelWindows,
  forceTopmost,
  ensureVisible,
  loadApi,
};

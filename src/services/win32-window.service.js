'use strict';

// Native Windows reinforcement for window properties (FIXED - kernel32 load + safe koffi)

const WDA_NONE = 0x00000000;
const WDA_MONITOR = 0x00000001;
const WDA_EXCLUDEFROMCAPTURE = 0x00000011;

const GWL_EXSTYLE = -20;
const WS_EX_TRANSPARENT = 0x00000020n;
const WS_EX_TOOLWINDOW = 0x00000080n;
const WS_EX_APPWINDOW = 0x00040000n;
const WS_EX_LAYERED = 0x00080000n;

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;

let api;

function nativeHandleToBigInt(handle) {
  if (!Buffer.isBuffer(handle)) throw new TypeError('Native window handle must be a Buffer.');
  if (handle.length >= 8) return handle.readBigUInt64LE(0);
  if (handle.length >= 4) return BigInt(handle.readUInt32LE(0));
  throw new RangeError('Native window handle buffer is too short.');
}

function loadWin32Api() {
  if (process.platform !== 'win32') return null;
  if (api !== undefined) return api;

  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const ntdll = koffi.load('ntdll.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const HANDLE = koffi.pointer('HANDLE', koffi.opaque());
    const HWND = koffi.alias('HWND', HANDLE);
    const DWORD = koffi.alias('DWORD', 'uint32_t');
    const BOOL = koffi.alias('BOOL', 'int');
    const BOOLEAN = koffi.alias('BOOLEAN', 'uint8_t');
    const NTSTATUS = koffi.alias('NTSTATUS', 'int32_t');

    api = {
      SetWindowDisplayAffinity: user32.func('bool __stdcall SetWindowDisplayAffinity(HWND hWnd, DWORD dwAffinity)'),
      GetWindowDisplayAffinity: user32.func('bool __stdcall GetWindowDisplayAffinity(HWND hWnd, _Out_ DWORD *pdwAffinity)'),
      GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(HWND hWnd, int nIndex)'),
      SetWindowLongPtrW: user32.func('intptr_t __stdcall SetWindowLongPtrW(HWND hWnd, int nIndex, intptr_t dwNewLong)'),
      SetWindowPos: user32.func('bool __stdcall SetWindowPos(HWND hWnd, HWND hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)'),
      ChangeWindowMessageFilter: user32.func('BOOL __stdcall ChangeWindowMessageFilter(uint32_t message, DWORD dwFlag)'),
      RtlSetProcessIsCritical: ntdll.func('NTSTATUS __stdcall RtlSetProcessIsCritical(BOOLEAN bNewValue, _Out_opt_ BOOLEAN *pbOldValue, BOOLEAN bCheckFlag)'),
      GetCurrentProcess: kernel32.func('HANDLE __stdcall GetCurrentProcess()'),
      GetLastError: kernel32.func('DWORD __stdcall GetLastError()')
    };
  } catch (error) {
    api = { loadError: error.message };
  }
  return api;
}

function protectNativeWindow(nativeHandle, options = {}) {
  if (process.platform !== 'win32') return { supported: false, ok: false };
  const targetAffinity = typeof options.affinity === 'number' ? options.affinity : WDA_MONITOR;
  const win32 = loadWin32Api();
  if (!win32 || win32.loadError) {
    return { supported: false, ok: false, error: win32?.loadError || 'Win32 API unavailable' };
  }
  try {
    const hwnd = nativeHandleToBigInt(nativeHandle);
    const currentStyle = BigInt(win32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
    const desiredStyle = ((currentStyle | WS_EX_TOOLWINDOW | WS_EX_LAYERED) & ~WS_EX_APPWINDOW) & ~WS_EX_TRANSPARENT;
    if (desiredStyle !== currentStyle) {
      win32.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, desiredStyle);
      win32.SetWindowPos(hwnd, null, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    }
    const setOk = Boolean(win32.SetWindowDisplayAffinity(hwnd, targetAffinity));
    const affinity = [0];
    const getOk = Boolean(win32.GetWindowDisplayAffinity(hwnd, affinity));
    const value = Number(affinity[0]) >>> 0;
    const ok = setOk && getOk && value === targetAffinity;
    return {
      supported: true,
      ok,
      affinity: value,
      taskbarStyleApplied: (desiredStyle & WS_EX_TOOLWINDOW) !== 0n && (desiredStyle & WS_EX_APPWINDOW) === 0n,
      transparentStripped: (desiredStyle & WS_EX_TRANSPARENT) === 0n,
      compositeLayeredApplied: (desiredStyle & WS_EX_LAYERED) !== 0n,
      errorCode: ok ? 0 : Number(win32.GetLastError())
    };
  } catch (error) {
    return { supported: true, ok: false, error: error.message };
  }
}

function setProcessCritical(enable = true) {
  if (process.platform !== 'win32') return { supported: false, ok: false };
  const win32 = loadWin32Api();
  if (!win32 || win32.loadError || !win32.RtlSetProcessIsCritical) {
    return { supported: false, ok: false, error: win32?.loadError || 'NT API unavailable' };
  }
  try {
    const oldVal = [0];
    const status = win32.RtlSetProcessIsCritical(enable ? 1 : 0, oldVal, 0);
    return { supported: true, ok: status === 0, status };
  } catch (err) {
    return { supported: true, ok: false, error: err.message };
  }
}

function elevateUipiFilters() {
  if (process.platform !== 'win32') return { supported: false, ok: false };
  const win32 = loadWin32Api();
  if (!win32 || win32.loadError || !win32.ChangeWindowMessageFilter) {
    return { supported: false, ok: false };
  }
  try {
    const MSGFLT_ADD = 1;
    const messages = [0x004A, 0x0010, 0x001C, 0x0086, 0x0006];
    for (const msg of messages) win32.ChangeWindowMessageFilter(msg, MSGFLT_ADD);
    return { supported: true, ok: true };
  } catch (err) {
    return { supported: true, ok: false, error: err.message };
  }
}

module.exports = {
  WDA_NONE,
  WDA_MONITOR,
  WDA_EXCLUDEFROMCAPTURE,
  WS_EX_TRANSPARENT,
  WS_EX_LAYERED,
  nativeHandleToBigInt,
  protectNativeWindow,
  setProcessCritical,
  elevateUipiFilters,
  loadWin32Api
};

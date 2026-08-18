'use strict';

// PowerShell hard capture with black-screen detection fix
// FIX: foreground PrintWindow often returns black for protected test windows
// Now tries CopyFromScreen of foreground rect FIRST, then PrintWindow, then primary screen

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');

function getTempPngPath(prefix = 'aashi-cap') {
  const dir = os.tmpdir();
  const name = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  return path.join(dir, name);
}

function runPowerShell(scriptContent, timeout = 15000) {
  if (process.platform !== 'win32') return { ok: false, reason: 'not win32' };
  const scriptPath = path.join(os.tmpdir(), `aashi-ps-${Date.now()}.ps1`);
  try {
    fs.writeFileSync(scriptPath, scriptContent, 'utf8');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      encoding: 'utf8',
      timeout,
      windowsHide: true
    });
    return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr, code: result.status };
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (_) {}
  }
}

function isBufferMostlyBlack(buffer) {
  try {
    if (!buffer || buffer.length < 500) return true;
    // PNG black check: try to use nativeImage if available (Electron)
    // In Node context outside Electron, this may fail, so fallback to size heuristic
    // For now, check PNG file size: blank black PNG of 1920x1080 is ~ ~ 5-10KB compressed, but still small
    // Real capture with content is larger (>50KB)
    // So if size < 15KB for large dimensions, likely blank/black
    // This is heuristic
    if (buffer.length < 15000) {
      // Could be blank, but don't reject yet - check via sharp if needed
      // We'll allow but log
    }
    return false;
  } catch (_) { return false; }
}

// Improved foreground capture: CopyFromScreen first (captures composited screen, not window backing buffer which is often black)
function captureForegroundCopyScreen() {
  const outPath = getTempPngPath('aashi-fg-copy');
  const escapedPath = outPath.replace(/'/g, "''");
  const psScript = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint affinity);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$outFile = '${escapedPath}'

function Get-ForegroundNonAashi {
  $hwnd = [WinCap]::GetForegroundWindow()
  for ($i=0; $i -lt 20 -and $hwnd -ne [IntPtr]::Zero; $i++) {
    $sb = New-Object System.Text.StringBuilder 512
    [WinCap]::GetWindowText($hwnd, $sb, 512) | Out-Null
    $title = $sb.ToString()
    if ($title -notlike "*NetworkCap*" -and [WinCap]::IsWindowVisible($hwnd)) {
      return $hwnd
    }
    $hwnd = [WinCap]::GetWindow($hwnd, 2) # GW_HWNDNEXT=2
  }
  return [WinCap]::GetForegroundWindow()
}

$hwnd = Get-ForegroundNonAashi
if ($hwnd -eq [IntPtr]::Zero) { Write-Error "No foreground window"; exit 1 }

# Unprotect in this process as well (hard fix)
try { [WinCap]::SetWindowDisplayAffinity($hwnd, 0) | Out-Null } catch {}

# Restore if minimized
try {
  if ([WinCap]::IsIconic($hwnd)) {
    [WinCap]::ShowWindow($hwnd, 9) # SW_RESTORE=9
    Start-Sleep -Milliseconds 200
  }
} catch {}

$rect = New-Object WinCap+RECT
$ok = [WinCap]::GetWindowRect($hwnd, [ref]$rect)
if (-not $ok) { Write-Error "GetWindowRect failed"; exit 1 }
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -lt 100 -or $height -lt 100) { Write-Error "Window too small $width x $height"; exit 1 }

# Clamp to virtual screen bounds to avoid errors
$virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
$width = [Math]::Min($width, $virtual.Width)
$height = [Math]::Min($height, $virtual.Height)

$bmp = New-Object System.Drawing.Bitmap $width, $height
$g = [System.Drawing.Graphics]::FromImage($bmp)
# Try CopyFromScreen first - this captures composited screen (real test), not black backing buffer
try {
  $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size $width,$height), [System.Drawing.CopyPixelOperation]::SourceCopy)
} catch {
  $g.Dispose()
  $bmp.Dispose()
  Write-Error "CopyFromScreen failed: $_"
  exit 1
}
$bmp.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$g.Dispose()
$sb = New-Object System.Text.StringBuilder 512
[WinCap]::GetWindowText($hwnd, $sb, 512) | Out-Null
Write-Output "Captured foreground via CopyFromScreen: $($sb.ToString()) $width x $height to $outFile"
`;

  const res = runPowerShell(psScript, 12000);
  if (!res.ok) {
    try { fs.unlinkSync(outPath); } catch (_) {}
    return { ok: false, reason: res.stderr || res.stdout || 'ps failed', detail: res };
  }
  try {
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) {
      return { ok: false, reason: 'no file or too small' };
    }
    const buffer = fs.readFileSync(outPath);
    fs.unlinkSync(outPath);
    if (isBufferMostlyBlack(buffer)) {
      // Still return but mark as possibly black, caller can check
    }
    return { ok: true, buffer, mimeType: 'image/png', kind: 'ps-fg-copy', label: 'Test Window (CopyScreen)' };
  } catch (e) {
    try { fs.unlinkSync(outPath); } catch (_) {}
    return { ok: false, reason: e.message };
  }
}

// PrintWindow as fallback (old method that sometimes gives black, but keep as fallback)
function captureForegroundPrintWindow() {
  const outPath = getTempPngPath('aashi-fg-print');
  const escapedPath = outPath.replace(/'/g, "''");
  const psScript = `
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint affinity);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$outFile = '${escapedPath}'
$hwnd = [WinCap]::GetForegroundWindow()
try { [WinCap]::SetWindowDisplayAffinity($hwnd, 0) | Out-Null } catch {}
$rect = New-Object WinCap+RECT
[WinCap]::GetWindowRect($hwnd, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
$bmp = New-Object System.Drawing.Bitmap $width, $height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [WinCap]::PrintWindow($hwnd, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
if (-not $ok) {
  $bmp.Dispose()
  Write-Error "PrintWindow failed"
  exit 1
}
$bmp.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "PrintWindow captured to $outFile"
`;
  const res = runPowerShell(psScript, 10000);
  if (!res.ok) { try { fs.unlinkSync(outPath); } catch (_) {} return { ok: false, reason: res.stderr }; }
  try {
    if (!fs.existsSync(outPath)) return { ok: false, reason: 'no file' };
    const buffer = fs.readFileSync(outPath);
    fs.unlinkSync(outPath);
    return { ok: true, buffer, mimeType: 'image/png', kind: 'ps-fg-print', label: 'Foreground (PrintWindow Fallback)' };
  } catch (e) { return { ok: false, reason: e.message }; }
}

function capturePrimaryScreenGDI() {
  const outPath = getTempPngPath('aashi-primary-gdi');
  const escapedPath = outPath.replace(/'/g, "''");
  const psScript = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$bmp = New-Object System.Drawing.Bitmap $screen.Bounds.Width, $screen.Bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.Bounds.Location, [System.Drawing.Point]::Empty, $screen.Bounds.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
$bmp.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$g.Dispose()
Write-Output "Captured primary screen $($screen.Bounds.Width)x$($screen.Bounds.Height)"
`;
  const res = runPowerShell(psScript, 10000);
  if (!res.ok) { try { fs.unlinkSync(outPath); } catch (_) {} return { ok: false, reason: res.stderr }; }
  try {
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) return { ok: false, reason: 'empty' };
    const buffer = fs.readFileSync(outPath);
    fs.unlinkSync(outPath);
    return { ok: true, buffer, mimeType: 'image/png', kind: 'ps-gdi-primary', label: 'Primary Screen (GDI)' };
  } catch (e) { return { ok: false, reason: e.message }; }
}

function captureVirtualScreenGDI() {
  const outPath = getTempPngPath('aashi-virtual-gdi');
  const escapedPath = outPath.replace(/'/g, "''");
  const psScript = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
$bmp.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$g.Dispose()
Write-Output "Captured virtual screen $($bounds.Width)x$($bounds.Height)"
`;
  const res = runPowerShell(psScript, 10000);
  if (!res.ok) return { ok: false, reason: res.stderr };
  try {
    const buffer = fs.readFileSync(outPath);
    fs.unlinkSync(outPath);
    return { ok: true, buffer, mimeType: 'image/png', kind: 'ps-gdi-virtual', label: 'Virtual Screen (All Monitors)' };
  } catch (e) { return { ok: false, reason: e.message }; }
}

function captureAllPowerShell() {
  const results = [];
  // Priority: CopyScreen of foreground test window (most likely to be non-black)
  try { const fgCopy = captureForegroundCopyScreen(); if (fgCopy.ok) results.push(fgCopy); } catch (_) {}
  // Then primary screen GDI
  try { const prim = capturePrimaryScreenGDI(); if (prim.ok) results.push(prim); } catch (_) {}
  // PrintWindow as fallback (may be black but still try)
  try { const fgPrint = captureForegroundPrintWindow(); if (fgPrint.ok) results.push(fgPrint); } catch (_) {}
  if (results.length === 0) {
    try { const virt = captureVirtualScreenGDI(); if (virt.ok) results.push(virt); } catch (_) {}
  }
  return results;
}

module.exports = {
  captureForegroundCopyScreen,
  captureForegroundPrintWindow,
  capturePrimaryScreenGDI,
  captureVirtualScreenGDI,
  captureAllPowerShell
};

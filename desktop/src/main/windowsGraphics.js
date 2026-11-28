import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

export const WINDOWS_GRAPHICS_SETTINGS = "ms-settings:display-advancedgraphics";
const run = promisify(execFile);
const choices = Object.freeze({ default: "0", "power-saving": "1", "high-performance": "2" });

// Use the same per-user, per-executable preference as Windows Graphics Settings
// so the native Spout device and Chromium can both use the Windows choice.
const registryScript = String.raw`
$ErrorActionPreference = 'Stop'
$path = 'Software\Microsoft\DirectX\UserGpuPreferences'
$name = $env:HYDRACTRL_GRAPHICS_EXE
$choice = $env:HYDRACTRL_GRAPHICS_CHOICE
$root = [Microsoft.Win32.Registry]::CurrentUser
$key = $root.OpenSubKey($path, [bool]$choice)
try {
  $previous = if ($key) { $key.GetValue($name) }
  if ($null -ne $previous -and $previous -isnot [string]) {
    throw 'Unsupported Windows graphics preference value.'
  }
  $parts = @($previous -split ';' | Where-Object { $_ })
  if ($choice) {
    $parts = @($parts | Where-Object { $_ -notmatch '^GpuPreference=' })
    if ($choice -ne '0') { $parts += "GpuPreference=$choice" }
    if ($parts.Count) {
      if (!$key) { $key = $root.CreateSubKey($path) }
      $key.SetValue($name, ($parts -join ';') + ';', [Microsoft.Win32.RegistryValueKind]::String)
    } elseif ($null -ne $previous) {
      $key.DeleteValue($name, $false)
    }
  }
  foreach ($entry in $parts) {
    if ($entry -match '^GpuPreference=(.*)$') {
      [Console]::WriteLine($Matches[1])
      exit
    }
  }
  [Console]::WriteLine('0')
} finally {
  if ($key) { $key.Dispose() }
}
`;

export async function windowsGraphicsPreference(executable, preference) {
  if (preference !== undefined && !Object.hasOwn(choices, preference)) {
    throw new Error("Unknown graphics preference.");
  }
  const powershell = join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  try {
    const { stdout } = await run(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", registryScript],
      {
        windowsHide: true,
        timeout: 8000,
        env: {
          ...process.env,
          HYDRACTRL_GRAPHICS_EXE: executable,
          HYDRACTRL_GRAPHICS_CHOICE: choices[preference] ?? "",
        },
      },
    );
    return Object.keys(choices).find((key) => choices[key] === stdout.trim()) ?? "custom";
  } catch (error) {
    const action = preference === undefined ? "read" : "save";
    throw new Error(`Could not ${action} the graphics preference. Try Windows Graphics Settings.`, {
      cause: error,
    });
  }
}

export function activeGraphicsRenderer(info) {
  return (
    info?.auxAttributes?.glRenderer ||
    info?.gpuDevice?.find((device) => device.active)?.deviceString ||
    null
  );
}

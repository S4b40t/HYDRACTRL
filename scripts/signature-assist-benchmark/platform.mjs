import { constants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function number(env, key, fallback, min, max) {
  const value = Number(env[key] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function configuration(env) {
  const mode = env.BENCH_MODE ?? "hardware";
  const profile = env.BENCH_PROFILE ?? "full";
  if (!["hardware", "software"].includes(mode))
    throw new Error("Use BENCH_MODE=hardware or software");
  if (!["pilot", "full", "targeted", "targeted-pilot"].includes(profile))
    throw new Error("Use BENCH_PROFILE=pilot, full, targeted or targeted-pilot");
  const pilot = profile.endsWith("pilot");
  const targeted = profile.startsWith("targeted");
  const stage = env.BENCH_STAGE ?? "all";
  if (stage !== "all" && (stage !== "heap" || !targeted))
    throw new Error("BENCH_STAGE=heap requires a targeted profile");
  if (targeted && !env.BENCH_FIXTURE)
    throw new Error("Set BENCH_FIXTURE to the path of the reviewed Setup file");
  const revision = env.BENCH_REVISION?.toLowerCase();
  if ((revision && !/^[a-f\d]{40}$/.test(revision)) || (mode === "hardware" && !revision)) {
    throw new Error("Set BENCH_REVISION to the exact 40-character commit SHA");
  }
  const port = number(env, "BENCH_PORT", 43127, 1024, 65535);
  if (port === 3000) throw new Error("Use a dedicated port, never HYDRACTRL's normal port 3000");
  if (env.HYDRACTRL_URL)
    throw new Error("The benchmark starts its own server; clear HYDRACTRL_URL");
  return {
    mode,
    profile,
    pilot,
    targeted,
    stage,
    fixturePath: targeted ? path.resolve(env.BENCH_FIXTURE) : null,
    snapshotDirectory:
      targeted && env.BENCH_HEAP_SNAPSHOTS_DIR ? path.resolve(env.BENCH_HEAP_SNAPSHOTS_DIR) : null,
    revision,
    port,
    pairs: number(env, "PAIRS", pilot ? 1 : 5, pilot ? 1 : 5, 20),
    warmMs: number(env, "BENCH_WARM_MS", pilot ? 800 : 5000, 500, 60_000),
    idleMs: number(env, "BENCH_IDLE_MS", pilot ? 1300 : 15_000, pilot ? 500 : 15_000, 120_000),
    editMs: number(env, "BENCH_EDIT_MS", pilot ? 1400 : 15_000, pilot ? 500 : 15_000, 120_000),
    heapCycles: number(
      env,
      "BENCH_HEAP_CYCLES",
      pilot ? 2 : targeted ? 60 : 30,
      pilot ? 2 : targeted ? 60 : 20,
      200,
    ),
    heapPairs: number(env, "BENCH_HEAP_PAIRS", pilot ? 1 : 2, pilot ? 1 : 2, 10),
    output: path.resolve(
      env.BENCH_OUTPUT ?? path.join(os.tmpdir(), `hydractrl-${mode}-${profile}-${Date.now()}.json`),
    ),
    headless: mode === "software",
    // Playwright defaults can include unsafe SwiftShader fallback. Exclude it in hardware mode.
    args: mode === "software" ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : [],
  };
}

export function browserCandidates(platform, env) {
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean);
    return [
      "Microsoft/Edge/Application/msedge.exe",
      "Google/Chrome/Application/chrome.exe",
    ].flatMap((executable) => roots.map((root) => path.win32.join(root, executable)));
  }
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  return [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/microsoft-edge",
  ];
}

export async function browserExecutable(env) {
  for (const candidate of env.CHROMIUM
    ? [path.resolve(env.CHROMIUM)]
    : browserCandidates(process.platform, env)) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error("Chromium/Edge not found. Set CHROMIUM to the full executable path.");
}

export function isolatedServerEnv(env, port) {
  return { ...env, HOST: "127.0.0.1", PORT: String(port), HYDRACTRL_MEDIA_DIR: "" };
}

export function classifyGpu(webgl, gpu) {
  const renderer = webgl.renderer ?? "";
  const vendor = webgl.vendor ?? "";
  const auxiliary = gpu?.auxAttributes ?? {};
  const text = [renderer, vendor, auxiliary.glRenderer, auxiliary.glImplementationParts].join(" ");
  const software = /swiftshader|llvmpipe|softpipe|software|warp|basic render|lavapipe/i.test(text);
  const backend =
    text.match(/Direct3D(?:11|12|9)|D3D(?:11|12|9)|Vulkan|Metal|OpenGL(?: ES)?/i)?.[0] ?? null;
  const device = gpu?.devices?.[0];
  const hardwareVendor = /intel|amd|radeon|nvidia|geforce|quadro|apple|qualcomm|adreno|arm|mali/i;
  const confirmed = Boolean(
    webgl.unmasked &&
      backend &&
      renderer &&
      vendor &&
      device?.vendorId &&
      hardwareVendor.test(renderer) &&
      gpu?.featureStatus?.webgl === "enabled",
  );
  return { classification: software ? "software" : confirmed ? "hardware" : "uncertain", backend };
}

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { browserCandidates, classifyGpu, configuration, isolatedServerEnv } from "./platform.mjs";
import { startServer } from "./server.mjs";

assert.deepEqual(
  browserCandidates("win32", {
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\QA User\\AppData\\Local",
  }).slice(0, 4),
  [
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Users\\QA User\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ],
);
assert.equal(
  fileURLToPath("file:///C:/QA%20Copy/HYDRACTRL/", { windows: true }),
  "C:\\QA Copy\\HYDRACTRL\\",
);
const revision = "a".repeat(40);
const hardware = configuration({ BENCH_REVISION: revision });
assert.equal(hardware.headless, false);
assert.deepEqual(hardware.args, []);
assert.equal(hardware.pairs, 5);
assert.equal(hardware.idleMs, 15_000);
assert.throws(() => configuration({ BENCH_REVISION: revision, PAIRS: "2" }), /PAIRS/);
assert.throws(
  () => configuration({ BENCH_REVISION: revision, BENCH_IDLE_MS: "14999" }),
  /BENCH_IDLE_MS/,
);
assert.throws(
  () => configuration({ BENCH_REVISION: revision, BENCH_PORT: "3000" }),
  /dedicated port/,
);
assert.throws(
  () => configuration({ BENCH_REVISION: revision, HYDRACTRL_URL: "http://localhost:3000/app" }),
  /own server/,
);
const pilot = configuration({ BENCH_MODE: "software", BENCH_PROFILE: "pilot" });
assert.equal(pilot.pairs, 1);
assert.equal(pilot.headless, true);
assert.ok(pilot.args.includes("--use-angle=swiftshader"));
assert.deepEqual(
  isolatedServerEnv({ HYDRACTRL_MEDIA_DIR: "C:\\Live Media", PORT: "3000" }, 43127),
  {
    HOST: "127.0.0.1",
    PORT: "43127",
    HYDRACTRL_MEDIA_DIR: "",
  },
);
const gpu = { devices: [{ vendorId: 0x8086 }], featureStatus: { webgl: "enabled" } };
const intel = {
  renderer: "ANGLE (Intel, Intel Iris Xe Graphics Direct3D11)",
  vendor: "Google Inc. (Intel)",
  unmasked: true,
};
assert.deepEqual(classifyGpu(intel, gpu), { classification: "hardware", backend: "Direct3D11" });
assert.equal(classifyGpu({ ...intel, unmasked: false }, gpu).classification, "uncertain");
assert.equal(classifyGpu(intel, null).classification, "uncertain");
for (const renderer of [
  "ANGLE (Vulkan SwiftShader)",
  "Microsoft Basic Render Driver / WARP",
  "llvmpipe",
]) {
  assert.equal(classifyGpu({ ...intel, renderer }, gpu).classification, "software");
}
const occupied = createServer();
try {
  occupied.listen(0, "127.0.0.1");
  await once(occupied, "listening");
  await assert.rejects(startServer("must-not-launch", ".", occupied.address().port), /unavailable/);
  assert.equal(occupied.listening, true);
} finally {
  await new Promise((resolve) => occupied.close(resolve));
}
console.log("Passed Windows path/config, GPU fallback, and occupied-port checks.");

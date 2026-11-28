/** Add Portable documentation and provenance to a freshly packaged Windows directory. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import asar from "@electron/asar";

const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = resolve(process.argv[2] || join(root, "desktop", "dist", "win-unpacked"));
const archive = join(directory, "resources", "app.asar");
const manifest = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
assert.equal(manifest.hydractrlPortable, true, "package must use electron-builder.portable.yml");
assert.match(manifest.version, /-portable\./, "stamp the prerelease version before packaging");
for (const component of [
  "HYDRACTRL.exe",
  "resources/server/hydractrl.exe",
  "resources/server/hydractrl-public/assets/index.js",
  "resources/server/hydractrl-public/assets/output.js",
  "resources/app.asar.unpacked/node_modules/@napolab/texture-bridge-win32-x64-msvc/index.win32-x64-msvc.node",
]) {
  const path = join(directory, component);
  assert.ok(existsSync(path), `Missing runtime file: ${component}`);
  if (/\.(exe|node)$/.test(path)) {
    const bytes = readFileSync(path);
    const pe = bytes.readUInt32LE(0x3c);
    assert.equal(bytes.toString("ascii", 0, 2), "MZ");
    assert.equal(bytes.readUInt16LE(pe + 4), 0x8664, `${component} must be Windows x64`);
  }
}
assert.ok(!existsSync(join(directory, "portable-data")), "Package must not contain a profile");
for (const [from, to] of [
  ["desktop/scripts/HydractrlPortable.cmd", "HydractrlPortable.cmd"],
  ["desktop/scripts/PORTABLE-README.md", "START HERE.md"],
  ["docs/MIDI.md", "MIDI.md"],
  ["docs/EDITOR-QOL.md", "EDITOR-QOL.md"],
  ["docs/SPECTRAL_ANALYSIS.md", "SPECTRAL_ANALYSIS.md"],
  ["docs/SIGNATURE-ASSIST.md", "SIGNATURE-ASSIST.md"],
  ["LICENSE", "LICENSE.HYDRACTRL.txt"],
]) {
  copyFileSync(join(root, from), join(directory, to));
}
const midiDiagnostic = join(directory, "midi-easing");
mkdirSync(midiDiagnostic, { recursive: true });
for (const name of ["README.md", "setup.js", "sketch.js"]) {
  copyFileSync(join(root, "docs", "midi-easing", name), join(midiDiagnostic, name));
}
const diagnostics = join(directory, "Spectral Diagnostics");
mkdirSync(diagnostics, { recursive: true });
for (const name of [
  "scene-a-frequency-separation.js",
  "scene-b-overlapping-bands.js",
  "scene-c-custom.js",
  "scene-c-legacy.js",
]) {
  copyFileSync(join(root, "docs", "spectral-analysis", name), join(diagnostics, name));
}
execFileSync(
  process.execPath,
  [
    join(root, "docs", "spectral-analysis", "generate-audio.mjs"),
    join(diagnostics, "spectral-diagnostics.wav"),
  ],
  { stdio: "inherit" },
);
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (process.env.GITHUB_SHA) assert.equal(sourceRevision, process.env.GITHUB_SHA);
const build = {
  sourceRevision,
  version: manifest.version,
  platform: "win32-x64",
  builtAt: new Date().toISOString(),
  electron: "45.0.0",
};
writeFileSync(join(directory, "BUILD-INFO.json"), `${JSON.stringify(build, null, 2)}\n`);
console.log(`HYDRACTRL-Portable-${manifest.version}-${sourceRevision.slice(0, 7)}-win-x64`);

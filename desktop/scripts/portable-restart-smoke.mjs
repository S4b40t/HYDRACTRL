/** Start the packaged Electron app twice against a new portable-data folder. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "playwright-core";

const executablePath = resolve(process.argv[2]);
const profile = join(dirname(executablePath), "portable-data");
if (existsSync(profile)) throw new Error("Run this test in a fresh Portable extraction.");

const origin = "http://127.0.0.1:43129";
const code = `const depth = midiParam("Depth", { default: 0.5, min: 0, max: 1 });
solid(() => portableScale(depth()), 0, 0).out();
globalThis.portableProbe = portableScale(depth());`;
const setup = "const portableScale = (value) => value * 0.5;";
const bankKey = "hydractrl-slot-bank-1-slot-3";
const bank = {
  version: 1,
  banks: [
    {
      bankIndex: 1,
      slots: [
        {
          slotIndex: 3,
          code: Buffer.from(encodeURIComponent(code)).toString("base64"),
          midi: [["Depth", { type: "cc", channel: 0, number: 23 }]],
        },
      ],
    },
  ],
};
const midiProfile = "hydractrl-midi-profile:portable-smoke";
const midiPreference = "hydractrl-midi-preferences";

async function start() {
  const app = await electron.launch({
    executablePath,
    args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    timeout: 45_000,
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(30_000);
    await page.waitForURL((url) => url.origin === origin && ["/", "/app"].includes(url.pathname));
    await page.waitForFunction(() => window.hydractrl && window.hydractrlDesktop);
    const state = await page.evaluate(() => window.hydractrlDesktop.getState());
    assert.equal(state.app.portable, true);
    assert.equal(state.server.mode, "spawned");
    assert.equal(state.server.port, 43129);
    return { app, page, state };
  } catch (error) {
    await app.close();
    throw error;
  }
}

const first = await start();
const firstProcess = first.app.process();
try {
  const { app, page, state } = first;
  assert.equal(state.settings.output.width, 1280);
  assert.equal(state.settings.output.height, 720);
  assert.equal(state.settings.output.frameRate, 60);
  assert.equal(state.settings.output.includeAlpha, true);
  assert.equal(await app.evaluate(({ app }) => app.getPath("userData")), profile);
  assert.equal(await app.evaluate(({ app }) => app.getPath("sessionData")), profile);
  await page.locator('[data-tab="setup"]').click();
  const editor = page.locator(".cm-content");
  await editor.press("Control+a");
  await page.keyboard.insertText(setup);
  await page.locator('[data-tab="main"]').click();
  page.on("dialog", (dialog) => dialog.accept());
  const chooser = page.waitForEvent("filechooser");
  await page.evaluate(() => window.slotsPanel.importSlots());
  await (await chooser).setFiles({
    name: "portable-bank.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(bank)),
  });
  await page.waitForFunction(
    (key) => localStorage.getItem(key) && localStorage.getItem(key + "-midi"),
    bankKey,
  );
  await page.evaluate(async () => {
    await window.hydractrlDesktop.updateSettings({ output: { width: 1600, height: 900 } });
  });
  await page.evaluate(
    ({ midiProfile, midiPreference }) => {
      localStorage.setItem(midiPreference, JSON.stringify({ id: "portable-smoke" }));
      localStorage.setItem(
        midiProfile,
        JSON.stringify({ slot: { type: "cc", channel: 0, number: 48 } }),
      );
    },
    { midiProfile, midiPreference },
  );
} finally {
  await first.app.close();
}
assert.equal(firstProcess.exitCode, 0);

const second = await start();
const secondProcess = second.app.process();
try {
  assert.notEqual(secondProcess.pid, firstProcess.pid);
  assert.equal(second.state.settings.output.width, 1600);
  assert.equal(second.state.settings.output.height, 900);
  const saved = await second.page.evaluate(
    (keys) => keys.map((key) => localStorage.getItem(key)),
    [bankKey, bankKey + "-midi", "hydractrl-setup-code", midiPreference, midiProfile],
  );
  assert.equal(saved[0], code);
  assert.deepEqual(JSON.parse(saved[1]), bank.banks[0].slots[0].midi);
  assert.equal(saved[2], setup);
  assert.deepEqual(JSON.parse(saved[3]), { id: "portable-smoke" });
  assert.deepEqual(JSON.parse(saved[4]), { slot: { type: "cc", channel: 0, number: 48 } });
  await second.page.evaluate(() => window.slotsPanel.switchBank(1, 3));
  await second.page.waitForFunction(() => window.portableProbe === 0.25);
  assert.equal(
    await second.page.evaluate(() => window.hydractrl.plugins.getStatus("signature-assist")),
    "active",
  );
} finally {
  await second.app.close();
}
assert.equal(secondProcess.exitCode, 0);
console.log(
  "Portable restart passed: imported bank, Setup, MIDI profile, sketch binding, and settings.",
);

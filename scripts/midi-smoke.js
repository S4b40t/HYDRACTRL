/**
 * Optional browser regression test against a running HYDRACTRL server.
 * HYDRACTRL_URL defaults to http://127.0.0.1:3000.
 * CHROMIUM_PATH may name a system Chromium if Playwright's is unavailable.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const url = process.env.HYDRACTRL_URL || "http://127.0.0.1:3000";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
});

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.on("dialog", (dialog) => dialog.accept());
  await page.addInitScript(() => {
    const inputs = new Map(
      [
        ["generic", "Performance controller"],
        ["nano", "Korg nanoPAD2"],
      ].map(([id, name]) => [id, { id, name, type: "input", state: "connected" }]),
    );
    const access = { inputs };
    navigator.requestMIDIAccess = async () => access;
    window.midiTest = {
      send(id, bytes) {
        inputs.get(id).onmidimessage?.({ data: Uint8Array.from(bytes) });
      },
      connection(id, state) {
        const input = inputs.get(id);
        input.state = state;
        access.onstatechange?.({ port: input });
      },
    };
    if (localStorage.getItem("smoke-ready")) return;
    const slot = (bank, index, name) => {
      localStorage.setItem(
        `hydractrl-slot-bank-${bank}-slot-${index}`,
        `globalThis.midiRuns = (globalThis.midiRuns || 0) + 1;
         globalThis.midiScene = ${JSON.stringify(name)};
         globalThis.midiValue = midiParam(${JSON.stringify(name)}, { default: 0.5, min: 0, max: 1, smoothing: 25 });
         solid(midiValue, 0, 0).out();`,
      );
    };
    slot(0, 0, "First");
    slot(0, 15, "Last");
    slot(1, 15, "Other");
    slot(2, 4, "Nano");
    localStorage.setItem(
      "hydractrl-midi-mapping",
      JSON.stringify([[], [], [{ note: 71, slot: 4 }], []]),
    );
    localStorage.setItem("smoke-ready", "1");
  });

  const send = (bytes, input = "generic") =>
    page.evaluate(({ bytes, input }) => window.midiTest.send(input, bytes), { bytes, input });
  const scene = (target, name) =>
    target.waitForFunction((value) => window.midiScene === value, name);
  const midiReady = () =>
    page.waitForFunction(() => window.midiManager?.isConnected() && window.hydractrl);
  const openSystem = async () => {
    if (!(await page.locator(".stats-midi").isVisible()))
      await page.locator(".stats-toggle").click();
  };
  const learn = async (label, message, release) => {
    const row = page.getByText(label, { exact: true }).locator("..");
    await row.getByRole("button", { name: "Learn", exact: true }).click();
    await send(message);
    if (release) await send(release);
  };

  await page.goto(`${url}/app`);
  await midiReady();
  await scene(page, "First");
  await openSystem();
  await page.getByRole("combobox", { name: "MIDI input" }).selectOption("generic");
  await page.getByText("MIDI mappings", { exact: true }).click();
  await learn("Pending slot · Unassigned", [0xb0, 21, 127]);
  await learn("Confirm pending slot · Unassigned", [0xb0, 22, 127], [0xb0, 22, 0]);
  await learn("Next pending bank · Unassigned", [0x90, 100, 90], [0x80, 100, 0]);
  await learn("Previous pending bank · Unassigned", [0xb0, 21, 127], [0xb0, 21, 0]);
  await page.getByText("Already assigned to Pending slot.", { exact: true }).waitFor();
  await learn("First · Unassigned", [0xb0, 31, 100]);

  const head = await context.newPage();
  await head.goto(`${url}/output?primary`);
  await scene(head, "First");
  const initialRuns = await page.evaluate(() => window.midiRuns);
  const initialOutputRuns = await head.evaluate(() => window.midiRuns);
  for (let slot = 0; slot < 16; slot++) {
    await send([0xb0, 21, slot * 8]);
    assert.equal(
      await page.locator(".pending-slot-indicator").textContent(),
      `Pending slot ${slot + 1} · Bank 1`,
    );
  }
  await send([0x90, 100, 90]);
  await send([0x90, 100, 90]);
  await send([0x80, 100, 0]);
  assert.equal(
    await page.locator(".pending-slot-indicator").textContent(),
    "Pending slot 16 · Bank 2",
  );
  assert.equal(await page.evaluate(() => window.midiRuns), initialRuns);
  assert.equal(await head.evaluate(() => window.midiRuns), initialOutputRuns);
  assert.equal(await page.evaluate(() => window.slotsPanel.getBank()), 0);

  for (const value of [127, 127, 0, 0]) await send([0xb0, 22, value]);
  await scene(page, "Other");
  await scene(head, "Other");
  assert.equal(await page.evaluate(() => window.midiRuns), initialRuns + 1);
  assert.equal(await head.evaluate(() => window.midiRuns), initialOutputRuns + 1);
  assert.equal(await head.locator(".pending-slot-indicator").count(), 0);

  await learn("Other · Unassigned", [0xb0, 31, 100]);
  await send([0xb0, 31, 127]);
  assert.equal(await page.evaluate(() => window.midiValue()), 0.5);
  await send([0xb0, 31, 64]);
  assert.equal(await page.evaluate(() => window.midiValue()), 0.5);
  await send([0xb0, 31, 95]);
  const newValue = 95 / 127;
  await page.waitForFunction((value) => window.midiValue() === value, newValue);
  await head.waitForFunction((value) => window.midiValue() === value, newValue);
  assert.equal(await page.evaluate(() => window.midiRuns), initialRuns + 1);
  assert.equal(await head.evaluate(() => window.midiRuns), initialOutputRuns + 1);

  const download = page.waitForEvent("download");
  await page.evaluate(() => window.slotsPanel.exportAllSlots());
  const path = await (await download).path();
  const bank = JSON.parse(await readFile(path, "utf-8"));
  assert.deepEqual(bank.banks[1].slots[0].midi, [
    ["Other", { type: "cc", channel: 0, number: 31 }],
  ]);
  await page.evaluate(() => localStorage.removeItem("hydractrl-slot-bank-1-slot-15-midi"));
  const chooser = page.waitForEvent("filechooser");
  await page.evaluate(() => window.slotsPanel.importSlots());
  await (await chooser).setFiles({
    name: "midi-bank.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(bank)),
  });
  await page.waitForFunction(() => localStorage.getItem("hydractrl-slot-bank-1-slot-15-midi"));
  await scene(page, "First");

  await page.reload();
  await midiReady();
  await scene(page, "First");
  await openSystem();
  assert.equal(await page.getByRole("combobox", { name: "MIDI input" }).inputValue(), "generic");
  assert.equal(await page.evaluate(() => window.midiManager.getNavigation().slot.number), 21);
  assert.equal(
    await page.evaluate(() => window.midiManager.getParameterMappings()[0].binding.number),
    31,
  );
  await send([0x90, 63, 100]);
  await scene(page, "Last");

  await page.evaluate(() => window.midiTest.connection("generic", "disconnected"));
  await page.getByText("MIDI · Selected input unavailable", { exact: true }).waitFor();
  await send([0x90, 71, 100], "nano");
  assert.equal(await page.evaluate(() => window.midiScene), "Last");
  await page.evaluate(() => window.midiTest.connection("generic", "connected"));
  await page.getByText("MIDI · Performance controller", { exact: true }).waitFor();
  await send([0x90, 48, 100]);
  await scene(page, "First");
  await page.getByRole("combobox", { name: "MIDI input" }).selectOption("nano");
  await send([0x90, 71, 100], "nano");
  await scene(page, "Nano");
  assert.deepEqual(
    await page.evaluate(() => [
      window.slotsPanel.getBank(),
      window.slotsPanel.getActiveSlotIndex(),
    ]),
    [2, 4],
  );
  console.log("MIDI browser smoke passed");
} finally {
  await browser.close();
}

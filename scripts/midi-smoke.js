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
      ].map(([id, name]) => {
        const currentId = id === "generic" ? localStorage.getItem("smoke-input-id") || id : id;
        return [
          currentId,
          { id: currentId, name, manufacturer: "MIDI Test", type: "input", state: "connected" },
        ];
      }),
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
    const slot = (bank, index, name, definition = { default: 0.5, min: 0, max: 1 }) => {
      localStorage.setItem(
        `hydractrl-slot-bank-${bank}-slot-${index}`,
        `globalThis.midiRuns = (globalThis.midiRuns || 0) + 1;
         globalThis.midiScene = ${JSON.stringify(name)};
         globalThis.midiValue = midiParam(${JSON.stringify(name)}, ${JSON.stringify({ ...definition, smoothing: 25 })});
         solid(midiValue, 0, 0).out();`,
      );
    };
    slot(0, 0, "First");
    slot(0, 15, "Last");
    slot(1, 15, "Other", { default: 3, min: 2, max: 4 });
    slot(2, 4, "Nano");
    localStorage.setItem(
      "hydractrl-midi-mapping",
      JSON.stringify([[], [], [{ note: 71, slot: 4 }], []]),
    );
    localStorage.setItem("smoke-ready", "1");
  });

  let genericId = "generic";
  const send = (bytes, input = genericId) =>
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
  const outputSocket = head.waitForEvent("websocket", (socket) =>
    socket.url().endsWith("/ws/output"),
  );
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
  await page.evaluate(() => {
    for (let index = 0; index < 1024; index++)
      window.midiTest.send("generic", [0xb0, 21, index % 128]);
  });
  assert.equal(await page.evaluate(() => window.midiRuns), initialRuns);
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
  assert.equal(await page.evaluate(() => window.midiValue()), 3);
  await send([0xb0, 31, 64]);
  assert.equal(await page.evaluate(() => window.midiValue()), 3);
  await send([0xb0, 31, 95]);
  const newValue = 2 + 2 * (95 / 127);
  await page.waitForFunction((value) => window.midiValue() === value, newValue);
  await head.waitForFunction((value) => window.midiValue() === value, newValue);
  assert.equal(await page.evaluate(() => window.midiRuns), initialRuns + 1);
  assert.equal(await head.evaluate(() => window.midiRuns), initialOutputRuns + 1);

  // A broken recall restores the playing sketch and its last MIDI target.
  await page.evaluate(() => {
    localStorage.setItem(
      "hydractrl-slot-bank-1-slot-0",
      'throw new Error("smoke runtime failure");',
    );
  });
  await send([0xb0, 21, 0]);
  await send([0xb0, 22, 127]);
  await send([0xb0, 22, 0]);
  await page.waitForFunction(() =>
    document.querySelector(".error-notification")?.textContent.includes("smoke runtime failure"),
  );
  assert.equal(await page.evaluate(() => window.midiValue()), newValue);
  assert.equal(await head.evaluate(() => window.midiValue()), newValue);
  assert.equal(await head.evaluate(() => window.midiRuns), initialOutputRuns + 1);
  await page.evaluate(() => localStorage.removeItem("hydractrl-slot-bank-1-slot-0"));

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

  // Old imports omit MIDI metadata. Replacing the slot also removes its old bindings.
  const legacyChooser = page.waitForEvent("filechooser");
  await page.evaluate(() => window.slotsPanel.importSlots());
  const other = { ...bank.banks[1].slots[0] };
  other.midi = undefined;
  await (await legacyChooser).setFiles({
    name: "legacy-bank.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ version: 1, banks: [{ bankIndex: 1, slots: [other] }] })),
  });
  await page.waitForFunction(
    () => localStorage.getItem("hydractrl-slot-bank-1-slot-15-midi") === null,
  );

  genericId = "generic-new-session";
  await page.evaluate((id) => localStorage.setItem("smoke-input-id", id), genericId);
  await page.reload();
  await midiReady();
  await scene(page, "First");
  await openSystem();
  assert.equal(await page.getByRole("combobox", { name: "MIDI input" }).inputValue(), genericId);
  assert.equal(await page.evaluate(() => window.midiManager.getNavigation().slot.number), 21);
  assert.equal(
    await page.evaluate(() => window.midiManager.getParameterMappings()[0].binding.number),
    31,
  );
  await send([0x90, 63, 100]);
  await scene(page, "Last");

  await page.evaluate((id) => window.midiTest.connection(id, "disconnected"), genericId);
  await page.getByText("MIDI · Selected input unavailable", { exact: true }).waitFor();
  await send([0x90, 71, 100], "nano");
  assert.equal(await page.evaluate(() => window.midiScene), "Last");
  await page.evaluate((id) => window.midiTest.connection(id, "connected"), genericId);
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

  const setup = await readFile(new URL("../docs/midi-easing/setup.js", import.meta.url), "utf8");
  const sketch = await readFile(new URL("../docs/midi-easing/sketch.js", import.meta.url), "utf8");
  await page.evaluate(
    ({ setup, sketch }) => {
      localStorage.setItem("hydractrl-setup-code", setup);
      localStorage.setItem(
        "hydractrl-slot-bank-0-slot-1",
        `globalThis.midiScene = "Easing diagnostic";\n${sketch}`,
      );
    },
    { setup, sketch },
  );
  await page.reload();
  await midiReady();
  await openSystem();
  await page.getByRole("combobox", { name: "MIDI input" }).selectOption(genericId);
  await send([0x90, 49, 100]);
  await scene(page, "Easing diagnostic");
  await scene(head, "Easing diagnostic");
  await page.getByText("MIDI mappings", { exact: true }).click();
  const labels = ["Linear", "Smoothstep", "Ease in", "Ease out", "Ease out power 4", "Elastic"];
  for (const [index, label] of labels.entries()) {
    await learn(`${label} · Unassigned`, [0xb0, 40 + index, 0]);
  }

  // Hold both transition clocks still while the numeric target is delivered.
  // Advance them together to observe the same progress on both renderers.
  const values = (renderer) =>
    renderer.evaluate(() => window.midiEasingDiagnostic.map((get) => get()));
  for (const renderer of [page, head]) {
    await renderer.evaluate(() => {
      window.midiEasingTime = performance.now();
      performance.now = () => window.midiEasingTime;
    });
  }
  const advance = (ms) =>
    Promise.all(
      [page, head].map((renderer) =>
        renderer.evaluate((ms) => {
          window.midiEasingTime += ms;
        }, ms),
      ),
    );
  for (let index = 0; index < labels.length; index++) await send([0xb0, 40 + index, 25]);
  const target = 76 / 127;
  const delivered = (await outputSocket).waitForEvent("framereceived", ({ payload }) => {
    const message = JSON.parse(payload);
    return (
      message.type === "parameters" &&
      message.values.some(([name, value]) => name === "Elastic" && value === target)
    );
  });
  for (let index = 0; index < labels.length; index++) await send([0xb0, 40 + index, 76]);
  await delivered;
  assert.deepEqual(await values(page), Array(6).fill(0.2));
  await advance(200);
  const between = 0.2 + (target - 0.2) * 0.5;
  const closeTo = (actual, expected) => Math.abs(actual - expected) < 1e-9;
  const editorValues = await values(page);
  assert.ok(closeTo(editorValues[0], target));
  assert.ok(closeTo(editorValues[1], between));
  assert.ok(closeTo(editorValues[2], 0.2 + (target - 0.2) / 4));
  assert.ok(closeTo(editorValues[3], target));
  assert.ok(closeTo(editorValues[4], 0.2 + (target - 0.2) * (15 / 16)));
  assert.ok(editorValues[5] > target && editorValues[5] <= 1);
  assert.deepEqual(await values(head), editorValues);
  await advance(400);
  assert.deepEqual(await values(page), Array(6).fill(target));
  assert.deepEqual(await values(head), Array(6).fill(target));
  await send([0x90, 48, 100]);
  await scene(page, "First");
  await scene(head, "First");
  await send([0x90, 49, 100]);
  await scene(page, "Easing diagnostic");
  await scene(head, "Easing diagnostic");
  assert.deepEqual(await values(page), Array(6).fill(0.2));
  assert.deepEqual(await values(head), Array(6).fill(0.2));
  console.log("MIDI browser smoke passed");
} finally {
  await browser.close();
}

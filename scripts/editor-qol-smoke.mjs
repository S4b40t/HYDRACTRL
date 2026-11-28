import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const fixture = process.env.HYDRACTRL_SETUP_FIXTURE;
const setupCode = fixture
  ? (await readFile(fixture, "utf8")).replace(/\r\n/g, "\n")
  : "/** Restricts a value to a range. */\nfunction clamp(value, minimum, maximum) {}";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || "/usr/bin/chromium",
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.env.HYDRACTRL_URL || "http://127.0.0.1:3000/app");
  await page.waitForFunction(
    () => window.hydractrl?.plugins.getStatus("signature-assist") === "active",
  );

  const editor = page.locator(".cm-content");
  const setup = page.locator('[data-tab="setup"]');
  const sketch = page.locator('[data-tab="main"]');
  const list = page.getByRole("listbox");
  const selected = page.locator(
    '.cm-tooltip-autocomplete:not(.cm-tooltip-autocomplete-disabled) [aria-selected="true"]',
  );
  const tip = page.locator(".cm-signature-assist");
  const label = tip.locator(".cm-signature-label");
  const code = () => page.evaluate(() => window._editorProxy._editor.getCode());
  const cursor = () => page.evaluate(() => window._editorProxy._editor.getSelection().head);

  async function replace(text) {
    await editor.press("Control+a");
    if (text) await page.keyboard.insertText(text);
    else await editor.press("Backspace");
  }

  async function suggest(name) {
    await editor.press("Control+Space");
    await selected.waitFor();
    assert.equal(await selected.locator(".cm-completionLabel").textContent(), name);
  }

  async function expectHint(signature) {
    await tip.waitFor();
    assert.equal(await label.textContent(), signature);
  }

  await replace("");
  await page.keyboard.type("os");
  await selected.waitFor();
  assert.match(await selected.textContent(), /^osc/);
  await editor.press("Tab");
  assert.equal(await code(), "osc()");
  assert.equal(await cursor(), 4);
  await expectHint("osc(frequency = 60, sync = 0.1, offset = 0)");
  await page.keyboard.type(")");
  assert.equal(await code(), "osc()");
  assert.equal(await cursor(), 5);

  await replace("osc().rot");
  await suggest("rotate");
  await editor.press("Tab");
  assert.equal(await code(), "osc().rotate()");
  await expectHint("rotate(angle = 10, speed = 0)");

  await replace("os(50)");
  await editor.press("Home");
  await editor.press("ArrowRight");
  await editor.press("ArrowRight");
  await suggest("osc");
  await editor.press("Enter");
  assert.equal(await code(), "osc(50)");
  assert.equal(await cursor(), 4);

  await replace("a.ff");
  await suggest("fft");
  await editor.press("Tab");
  assert.equal(await code(), "a.fft");
  await tip.waitFor({ state: "hidden" });
  await replace("unknownIdentifier");
  await list.waitFor({ state: "hidden" });
  await editor.press("Tab");
  assert.equal(await code(), "  unknownIdentifier");
  await editor.press("Shift+Tab");
  assert.equal(await code(), "unknownIdentifier");

  await replace("");
  await page.keyboard.type("([{");
  assert.equal(await code(), "([{}])");
  assert.equal(await cursor(), 3);
  await page.keyboard.type("}])");
  assert.equal(await code(), "([{}])");
  assert.equal(await cursor(), 6);
  await replace('"text"');
  await editor.press("ArrowLeft");
  await page.keyboard.type("(");
  assert.equal(await code(), '"text("');
  await replace("// comment");
  await page.keyboard.type("[");
  assert.equal(await code(), "// comment[");
  await replace("/* comment */");
  await editor.press("ArrowLeft");
  await editor.press("ArrowLeft");
  await page.keyboard.type("{");
  assert.equal(await code(), "/* comment {*/");

  await replace("s0.init");
  await suggest("init");
  await editor.press("ArrowDown");
  assert.notEqual(await selected.locator(".cm-completionLabel").textContent(), "init");
  await editor.press("ArrowUp");
  assert.equal(await selected.locator(".cm-completionLabel").textContent(), "init");
  await editor.press("Escape");
  await page.keyboard.press("Tab");
  await list.waitFor({ state: "hidden" });
  assert.equal(await editor.evaluate((node) => node.contains(document.activeElement)), false);
  assert.equal(await code(), "s0.init");
  await editor.focus();
  await editor.press("Control+m");
  await editor.press("Tab");
  assert.equal(await editor.evaluate((node) => node.contains(document.activeElement)), false);
  await editor.focus();
  await editor.press("Control+m");

  await setup.click();
  await replace(`globalThis.qolSetupRan = true;\n${setupCode}`);
  await sketch.click();
  await replace("clam");
  await suggest("clamp");
  assert.match(await selected.textContent(), /\(value, minimum, maximum\)/);
  await page
    .getByText(/Restricts a (?:value|number)/)
    .first()
    .waitFor();
  await editor.press("Tab");
  assert.equal(await code(), "clamp()");
  await expectHint("clamp(value, minimum, maximum)");
  assert.equal(await page.evaluate(() => window.qolSetupRan), undefined);

  await setup.click();
  const previousSetup = await code();
  await editor.press("Control+End");
  await page.waitForTimeout(600);
  await page.keyboard.insertText(
    "\n/** A newly edited helper. */\nconst qolHelper = (depth = 3) => depth;",
  );
  await sketch.click();
  await replace("qolH");
  await page.waitForTimeout(600);
  await suggest("qolHelper");
  await editor.press("Tab");
  assert.equal(await code(), "qolHelper()");
  await expectHint("qolHelper(depth = 3)");
  await editor.press("Control+z");
  assert.equal(await code(), "qolH");
  await setup.click();
  assert.match(await code(), /const qolHelper/);
  await editor.press("Control+z");
  assert.equal(await code(), previousSetup);
  await editor.press("Control+y");
  assert.match(await code(), /const qolHelper/);
  await sketch.click();
  assert.equal(await code(), "qolH");
  await editor.press("Control+y");
  assert.equal(await code(), "qolHelper()");

  // Exercise the existing Run shortcut and the registry with a runnable Setup.
  await setup.click();
  await replace(`setFunction({name: "qolSrc", type: "src", inputs: [], glsl: "return vec4(1.0);"});
setFunction({name: "qolColor", type: "color", inputs: [{name: "gain", type: "float", default: 1}], glsl: "return _c0 * gain;"});`);
  await sketch.click();
  await replace("osc().out(); globalThis.qolRan = true;");
  await editor.press("Control+Enter");
  await page.waitForFunction(() => window.qolRan === true);
  await editor.press("Control+s");
  assert.equal(
    await page.evaluate(() => localStorage.getItem("hydractrl-code")),
    "osc().out(); globalThis.qolRan = true;",
  );
  await replace("qolS");
  await suggest("qolSrc");
  await editor.press("Tab");
  await expectHint("qolSrc()");
  await replace("qolSrc().qolC");
  await suggest("qolColor");
  await editor.press("Tab");
  await expectHint("qolColor(gain = 1)");
  assert.equal(await code(), "qolSrc().qolColor()");
  await page.keyboard.press("Control+Backquote");
  await page.waitForFunction(() => document.body.classList.contains("ui-hidden"));
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.body.classList.contains("ui-hidden"));
  assert.deepEqual(errors, []);
  console.log(
    `Editor QoL browser acceptance passed (${fixture ? "Biotech Setup" : "inline fixture"})`,
  );
} finally {
  await browser.close();
}

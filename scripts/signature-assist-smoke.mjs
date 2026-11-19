import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || "/usr/bin/chromium",
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8_000);
  await page.addInitScript(() => {
    window.hydraDraws = 0;
    for (const Context of [WebGLRenderingContext, WebGL2RenderingContext]) {
      for (const method of ["drawArrays", "drawElements"]) {
        const draw = Context.prototype[method];
        Context.prototype[method] = function (...args) {
          if (this.canvas === document.querySelector("#hydra-canvas canvas")) window.hydraDraws++;
          return draw.apply(this, args);
        };
      }
    }
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.env.HYDRACTRL_URL || "http://127.0.0.1:3000/app");
  await page.waitForFunction(
    () => window.hydractrl?.plugins.getStatus("signature-assist") === "active",
  );

  const editor = page.locator(".cm-content");
  const tip = page.locator(".cm-signature-assist");
  const active = tip.locator("strong");

  async function replace(code) {
    await editor.press("Control+a");
    await page.keyboard.insertText(code);
  }

  async function expectParameter(name) {
    await active.filter({ hasText: name }).waitFor({ state: "visible" });
    assert.equal(await active.textContent(), name);
    assert.equal(await tip.textContent(), "osc(frequency, sync, offset)");
  }

  await replace("osc(60,");
  await expectParameter("sync");
  if (process.env.SIGNATURE_SCREENSHOT) {
    await page.screenshot({ path: process.env.SIGNATURE_SCREENSHOT });
  }
  await editor.press("ArrowLeft");
  await expectParameter("frequency");
  await editor.press("ArrowRight");
  await expectParameter("sync");
  await page.keyboard.insertText(" 0.1,");
  await expectParameter("offset");
  await editor.press("Escape");
  await tip.waitFor({ state: "hidden" });

  await replace("osc(osc(60,");
  await expectParameter("sync");
  await page.keyboard.insertText(" 0.1)");
  await expectParameter("frequency");
  await page.keyboard.insertText(", noi");
  await expectParameter("sync");
  await editor.press("Control+Space");
  const completion = page.getByRole("option", { name: /noise/ });
  await completion.first().waitFor({ state: "visible" });
  await expectParameter("sync");
  // CodeMirror ignores acceptance during its initial 75 ms interaction guard.
  await page.waitForTimeout(100);
  await editor.press("Enter");
  assert.match(await editor.innerText(), /noise\(/);

  await replace("osc(60,");
  await expectParameter("sync");
  await page.locator('[data-tab="setup"]').click();
  await tip.waitFor({ state: "hidden" });
  await page.locator('[data-tab="main"]').click();
  await replace("osc(60,");
  await expectParameter("sync");
  await page.locator('.slot[data-index="1"]').click();
  await tip.waitFor({ state: "hidden" });
  await replace("osc(60,");
  await expectParameter("sync");
  await editor.press("Control+Backquote");
  await page.locator("body.ui-hidden").waitFor({ state: "attached" });
  await tip.waitFor({ state: "hidden" });
  await page.locator("body").press("Escape");
  await page.locator("body.ui-hidden").waitFor({ state: "detached" });

  await page.evaluate(() => {
    window.testRuns = [];
    window.hydractrl.events.on("sketch:run", ({ main }) => window.testRuns.push(main));
  });
  await page.locator("#auto-run-checkbox").check();
  for (const frequency of [15, 25]) {
    const code = `osc(${frequency}, 0.1).out()`;
    await replace(code);
    await editor.press("Space");
    await page.waitForFunction(
      (expected) => window.testRuns.some((code) => code?.trim() === expected),
      code,
    );
    assert.equal(await page.locator("#hydra-canvas canvas").first().isVisible(), true);
    const beforeDraws = await page.evaluate(() => window.hydraDraws);
    await page.waitForFunction((before) => window.hydraDraws > before, beforeDraws);
    console.log(
      `Auto-run and WebGL draws observed with signature assist ${frequency === 15 ? "enabled" : "disabled"}.`,
    );

    if (frequency === 15) {
      await replace("osc(60,");
      await expectParameter("sync");
      assert.equal(
        await page.evaluate(() => window.hydractrl.plugins.unregister("signature-assist")),
        true,
      );
      await tip.waitFor({ state: "detached" });
      await replace("osc(60,");
      assert.equal(await tip.count(), 0);
    }
  }

  assert.deepEqual(errors, []);
  console.log(
    "Passed signature, nesting, autocomplete, tab, slot, visibility, disposal and auto-run checks.",
  );
} finally {
  await browser.close();
}

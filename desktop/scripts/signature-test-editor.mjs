// Drive the accepted renderer through the packaged app's smoke inspector.
export async function checkSignatureEditor({
  check,
  inMain,
  inMainWindow,
  mainWindow,
  fixture,
  sleep,
}) {
  const prepare = (tab, source, cursor = source.length) =>
    inMainWindow(`(() => {
      document.querySelector('.editor-tab[data-tab="${tab}"]').click();
      const view = document.querySelector(".cm-content").cmView.rootView.view;
      view.focus();
      view.dispatch({changes:{from:0,to:view.state.doc.length,insert:${JSON.stringify(source)}},
        selection:{anchor:${cursor}},scrollIntoView:true});
    })()`);
  const hint = () =>
    inMainWindow(`(() => {
    const tip = document.querySelector(".cm-signature-assist");
    return tip ? [tip.querySelector(".cm-signature-label")?.textContent, tip.querySelector("strong")?.textContent,
      tip.querySelector(".cm-signature-summary")?.textContent, tip.querySelector(".cm-signature-parameter")?.textContent] : null;
  })()`);
  async function waitHint(expected) {
    for (let i = 0; i < 28; i++) {
      if (JSON.stringify(await hint()) === JSON.stringify(expected)) return true;
      await sleep(100);
    }
    return false;
  }
  const key = (keyCode, modifiers = []) =>
    inMain(`
    const w = ${mainWindow};
    w.webContents.sendInputEvent({type:"keyDown",keyCode:${JSON.stringify(keyCode)},modifiers:${JSON.stringify(modifiers)}});
    w.webContents.sendInputEvent({type:"keyUp",keyCode:${JSON.stringify(keyCode)},modifiers:${JSON.stringify(modifiers)}});
  `);
  const native = ["osc(frequency = 60, sync = 0.1, offset = 0)", "sync = 0.1", null, null];
  const { label, active, summary, argument } = fixture.customHint;
  const custom = [label, active, summary, argument];
  await prepare("setup", fixture.setup);
  await prepare("main", "osc(60,");
  check("native active parameter in Electron", await waitHint(native));
  await key("Escape");
  check("Escape dismisses the hint", await waitHint(null));
  await prepare("main", "osc(60, noi");
  await key("Space", ["control"]);
  await sleep(400);
  check(
    "autocomplete coexists with Signature Assist",
    (await waitHint(native)) &&
      (await inMainWindow('Boolean(document.querySelector(".cm-tooltip-autocomplete"))')),
  );
  await key("Escape");
  await prepare("main", "osc(clamp(0.5,");
  check("nested helper and private Setup JSDoc", await waitHint(custom));
  const editedSummary = "Temporary smoke documentation.";
  await prepare("setup", fixture.setup.replace(summary, editedSummary));
  await prepare("main", "clamp(0.5,");
  check(
    "unsaved Setup edits refresh the hint after a tab switch",
    await waitHint([label, active, editedSummary, argument]),
  );
  await prepare("setup", fixture.setup);
  await prepare("main", "clamp(0.5,");
  check("unsaved Sketch and restored Setup resolve correctly", await waitHint(custom));

  // Inspect the host's registry through CDP while the original factory result is
  // still registered. This exercises the packaged client without modifying it.
  const captured = await inMain(`
    const debug = ${mainWindow}.webContents.debugger;
    debug.attach("1.3");
    try {
      const command = (method, args) => debug.sendCommand(method, args);
      const props = async (objectId) => command("Runtime.getProperties", {objectId, ownProperties:true});
      const fn = await command("Runtime.evaluate", {expression:"window.hydractrl.plugins.unregister",objectGroup:"signature-smoke"});
      const scopes = (await props(fn.result.objectId)).internalProperties?.find(x=>x.name==="[[Scopes]]")?.value;
      if (!scopes) return false;
      for (const entry of (await props(scopes.objectId)).result) {
        if (!entry.value?.objectId) continue;
        for (const variable of (await props(entry.value.objectId)).result) {
          if (variable.value?.subtype !== "map") continue;
          const captured = await command("Runtime.callFunctionOn", {
            objectId:variable.value.objectId,returnByValue:true,
            functionDeclaration:"function(){const entry=this.get('signature-assist');if(!entry?.plugin)return false;window.__signatureSmokePlugin=entry.plugin;return true;}",
          });
          if (captured.result.value === true) return true;
        }
      }
      return false;
    } finally {
      await debug.sendCommand("Runtime.releaseObjectGroup", {objectGroup:"signature-smoke"});
      debug.detach();
    }
  `).catch(() => false);
  check("capture the packaged plugin for lifecycle smoke", captured);
  if (captured) {
    const removed = await inMainWindow('window.hydractrl.plugins.unregister("signature-assist")');
    check("unregister removes the live tooltip", removed && (await waitHint(null)));
    const restored = await inMainWindow(`(() => {
      const plugin = window.__signatureSmokePlugin;
      delete window.__signatureSmokePlugin;
      return window.hydractrl.registerPlugin(plugin);
    })()`);
    await prepare("main", "clamp(0.5,");
    check("re-register restores the hint", restored && (await waitHint(custom)));
  }

  await inMainWindow(`(() => {
    window.__signatureSmokeRuns = 0;
    const off = window.hydractrl.events.on("sketch:run", () => window.__signatureSmokeRuns++);
    window.__finishSignatureSmoke = off;
    const autoRun = window.hydractrl.plugins.getApi("auto-run");
    if (autoRun.isEnabled()) autoRun.toggle();
  })()`);
  await prepare("main", fixture.sketch);
  await key("ArrowLeft");
  await sleep(600);
  check(
    "editing with auto-run off does not run",
    (await inMainWindow("window.__signatureSmokeRuns")) === 0,
  );
  await inMainWindow('window.hydractrl.plugins.getApi("auto-run").toggle()');
  await key("ArrowRight");
  await sleep(1000);
  check(
    "auto-run executes the vetted real-Setup sketch",
    (await inMainWindow("window.__signatureSmokeRuns")) > 0,
  );
  await inMainWindow(`(() => {
    window.hydractrl.plugins.getApi("auto-run").toggle();
    window.__finishSignatureSmoke();
    delete window.__finishSignatureSmoke;
    delete window.__signatureSmokeRuns;
  })()`);
}

// Installed only in benchmark browser contexts.
(() => {
  const probe = { events: [], phase: null };
  window.__signatureProbe = probe;
  const pluginId = "signature-assist";
  const phases = {};
  const runs = [];
  let renderer;
  let draws = 0;
  let fixture;
  let view;
  let phase;
  let typing;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const hint = () => document.querySelector(".cm-signature-assist");

  for (const Context of [WebGLRenderingContext, WebGL2RenderingContext]) {
    for (const method of ["drawArrays", "drawElements"]) {
      const draw = Context.prototype[method];
      Context.prototype[method] = function (...args) {
        if (
          this.canvas.parentElement?.id === "hydra-canvas" &&
          this.canvas.parentElement.firstElementChild === this.canvas
        ) {
          draws++;
          if (!renderer) {
            const debug = this.getExtension("WEBGL_debug_renderer_info");
            renderer = this.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? this.RENDERER);
          }
        }
        return draw.apply(this, args);
      };
    }
  }

  function start(name) {
    phase = name;
    probe.phase = name;
    phases[name] = {
      dispatchMs: [],
      intervalsMs: [],
      started: performance.now(),
      drawsBefore: draws,
    };
  }

  function end() {
    const data = phases[phase];
    data.durationMs = performance.now() - data.started;
    data.draws = draws - data.drawsBefore;
    phase = null;
    probe.phase = null;
  }

  let lastFrame;
  function sampleFrame(timestamp) {
    if (phase && phase === lastFrame?.phase) {
      phases[phase].intervalsMs.push(timestamp - lastFrame.timestamp);
    }
    lastFrame = { phase, timestamp };
    requestAnimationFrame(sampleFrame);
  }

  function positions() {
    const doc = view.state.doc;
    // The editing examples are the first three lines. Later padding stays untouched.
    return [1, 2, 3].map((line) => {
      const { from, text } = doc.line(line);
      const digit = Math.max(text.lastIndexOf("11"), text.lastIndexOf("12")) + 1;
      if (!digit) throw new Error(`Missing numeric edit target in ${text}`);
      return from + digit;
    });
  }

  function edit(position) {
    const old = view.state.sliceDoc(position, position + 1);
    view.dispatch({
      changes: { from: position, to: position + 1, insert: old === "1" ? "2" : "1" },
      selection: { anchor: position + 1 },
    });
  }

  function tab(id) {
    document.querySelector(`.editor-tab[data-tab="${id}"]`).click();
  }

  function observeTyping() {
    document.addEventListener(
      "beforeinput",
      (event) => {
        if (typing && event.target.closest(".cm-content")) {
          typing.beforeInputAt = performance.now();
          requestAnimationFrame(() => {
            if (!typing) return;
            typing.firstRafMs = performance.now() - typing.beforeInputAt;
            requestAnimationFrame(() => {
              if (typing) typing.secondRafMs = performance.now() - typing.beforeInputAt;
            });
          });
        }
      },
      true,
    );
    new MutationObserver(() => {
      if (typing?.beforeInputAt && typing.tooltipDomMs === undefined && hint()) {
        typing.tooltipDomMs = performance.now() - typing.beforeInputAt;
      }
    }).observe(view.dom, { subtree: true, childList: true });
  }

  window.signatureBenchmark = {
    async init(options) {
      fixture = options.fixture;
      const host = window.hydractrl.plugins;
      if (!options.enabled) host.unregister(pluginId);
      if (host.getStatus(pluginId) !== (options.enabled ? "active" : null)) {
        throw new Error("Signature Assist mode did not take effect");
      }
      // Benchmark-only access to the CodeMirror dispatch entry point.
      view = document.querySelector(".cm-content").cmView.rootView.view;
      const dispatch = view.dispatch;
      view.dispatch = (...args) => {
        const started = performance.now();
        dispatch(...args);
        if (phase) phases[phase].dispatchMs.push(performance.now() - started);
      };
      observeTyping();
      requestAnimationFrame(sampleFrame);
      window.hydractrl.events.on("sketch:run", ({ main }) => {
        if (main.includes("benchmarkScene")) runs.push({ phase, at: performance.now() });
      });
      tab("setup");
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: fixture.setup } });
      tab("main");
      for (const slot of [0, 1]) {
        localStorage.setItem(
          `hydractrl-slot-bank-0-slot-${slot}`,
          `${fixture.sketch}\n// measurement slot ${slot}`,
        );
      }
      document.querySelector('.slot[data-index="0"]').click();
      const autoRun = host.getApi("auto-run");
      if (autoRun.isEnabled() !== options.autoRun) autoRun.toggle();
      if (autoRun.isEnabled() !== options.autoRun)
        throw new Error("Auto-run mode did not take effect");
      await wait(500);
      const canvas = document.querySelector("#hydra-canvas canvas");
      if (!runs.length || !draws || canvas.width !== 1280 || canvas.height !== 720) {
        throw new Error(
          `Workload did not start: runs=${runs.length} draws=${draws} canvas=${canvas.width}x${canvas.height}`,
        );
      }
      return {
        renderer,
        width: canvas.width,
        height: canvas.height,
        mode: host.getStatus(pluginId),
        autoRun: options.autoRun,
      };
    },
    async prepareTyping(index) {
      const pos = positions()[index];
      view.focus();
      view.dispatch({ selection: { anchor: pos, head: pos + 1 } });
      await frame();
      typing = { index, pos };
      start(`typing-${index}`);
    },
    async finishTyping() {
      await frame();
      await frame();
      end();
      const result = { ...typing, tooltip: Boolean(hint()?.getBoundingClientRect().top >= 0) };
      if (view.state.sliceDoc(typing.pos, typing.pos + 1) !== "2" || !typing.beforeInputAt) {
        throw new Error("Trusted typing did not edit the target");
      }
      typing = null;
      return result;
    },
    async run() {
      await wait(400);
      start("idle");
      await wait(800);
      end();

      const targets = positions();
      // Prime the current tab and signature indexes outside timed navigation.
      view.dispatch({ selection: { anchor: targets[0] } });
      start("cursor");
      for (let repetition = 0; repetition < 36; repetition++) {
        view.dispatch({ selection: { anchor: targets[repetition % targets.length] } });
      }
      end();

      start("editing");
      for (let batch = 0; batch < 8; batch++) {
        for (const position of targets) edit(position);
        // The real auto-run listener receives one key event per valid edit batch.
        view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
        await wait(70);
      }
      end();

      start("after-edit");
      await wait(420);
      end();

      start("tab");
      for (let iteration = 0; iteration < 4; iteration++) {
        tab("setup");
        view.dispatch({ selection: { anchor: fixture.setup.indexOf("benchClamp(0.4,") + 16 } });
        tab("main");
        view.dispatch({ selection: { anchor: targets[0] } });
      }
      end();

      start("slot");
      for (const slot of [1, 0, 1, 0]) {
        document.querySelector(`.slot[data-index="${slot}"]`).click();
        view.dispatch({ selection: { anchor: targets[0] } });
        await wait(60);
      }
      end();
      return { phases, runs, cache: probe.events, visibleAfterSlot: Boolean(hint()) };
    },
    async cycle(install, control) {
      const host = window.hydractrl.plugins;
      if (install) {
        if (!control && (!probe.install() || host.getStatus(pluginId) !== "active"))
          throw new Error("Unable to register probe plugin");
        tab("setup");
        const end = view.state.doc.length;
        view.dispatch({ changes: { from: end, insert: " " } });
        view.dispatch({ changes: { from: end, to: end + 1 } });
        view.dispatch({ selection: { anchor: fixture.setup.indexOf("benchClamp(0.4,") + 16 } });
        tab("main");
        view.focus();
        const target = positions()[1];
        edit(target);
        edit(target);
      } else if (!control && (!host.unregister(pluginId) || host.getStatus(pluginId) !== null)) {
        throw new Error("Unable to unregister probe plugin");
      }
      await frame();
      await frame();
      return { mode: host.getStatus(pluginId), tooltip: Boolean(hint()) };
    },
  };
})();

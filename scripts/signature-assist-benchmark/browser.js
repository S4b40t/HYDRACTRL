// Installed only in benchmark browser contexts.
(() => {
  const probe = { events: [], phase: null };
  window.__signatureProbe = probe;
  const pluginId = "signature-assist";
  const phases = {};
  const runs = [];
  const visibility = [];
  document.addEventListener("visibilitychange", () => {
    visibility.push({ at: performance.now(), state: document.visibilityState });
  });
  let webgl;
  let timing;
  let draws = 0;
  let fixture;
  let view;
  let phase;
  let typing;
  let operation;
  let enabled;
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
          if (!webgl) {
            const debug = this.getExtension("WEBGL_debug_renderer_info");
            webgl = {
              renderer: this.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? this.RENDERER),
              vendor: this.getParameter(debug?.UNMASKED_VENDOR_WEBGL ?? this.VENDOR),
              unmasked: Boolean(debug),
              version: this.getParameter(this.VERSION),
            };
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
    probe.tab = id;
  }

  function autoRunKey() {
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
  }

  function extensionStatus() {
    const [field, focus, keys] = probe.extensionRefs?.map((ref) => ref.deref()) ?? [];
    return {
      field: Boolean(field && view.state.field(field, false) !== undefined),
      focus: Boolean(focus && view.state.facet(probe.focusEffect).includes(focus)),
      // view.plugin() memoizes misses and would keep a disposed plugin definition alive.
      keys: Boolean(keys && view.plugins.some(({ spec }) => spec === keys)),
    };
  }

  function setupChange(base, previous, next) {
    let start = 0;
    while (
      start < Math.min(previous.length, next.code.length) &&
      previous[start] === next.code[start]
    )
      start++;
    let tail = 0;
    while (
      tail < Math.min(previous.length, next.code.length) - start &&
      previous[previous.length - 1 - tail] === next.code[next.code.length - 1 - tail]
    )
      tail++;
    const anchor = next.call
      ? base + next.code.lastIndexOf(next.call) + next.call.lastIndexOf(", ") + 2
      : base + next.code.length - 2;
    view.dispatch({
      changes: {
        from: base + start,
        to: base + previous.length - tail,
        insert: next.code.slice(start, next.code.length - tail),
      },
      selection: { anchor },
      scrollIntoView: true,
    });
    return next.code;
  }

  async function checkSetupHint(expected) {
    const deadline = performance.now() + 6000;
    const expectedJson = JSON.stringify(enabled ? expected : null);
    await frame();
    while (JSON.stringify(window.signatureBenchmark.readHint()) !== expectedJson) {
      if (performance.now() > deadline)
        throw new Error("Unexpected Setup edit signature or documentation");
      await frame();
    }
    // Catch a stale hint that appears only after viewport parsing.
    await frame();
    if (JSON.stringify(window.signatureBenchmark.readHint()) !== expectedJson)
      throw new Error("Setup edit signature changed after settling");
  }

  async function setupEditing() {
    tab("setup");
    view.focus();
    const base = view.state.doc.length;
    let previous = "";
    const observations = {};
    const scenarios = Object.entries(fixture.setupScenarios);
    try {
      for (const [name, variants] of scenarios) {
        observations[name] = [];
        for (const next of variants) {
          previous = setupChange(base, previous, next);
          await checkSetupHint(next.hint);
          observations[name].push(window.signatureBenchmark.readHint());
        }

        start(`setup-${name}`);
        const cadence = 90;
        const duration = timing.editMs / scenarios.length;
        const scheduled = performance.now();
        for (let elapsed = 0, index = 0; elapsed < duration; elapsed += cadence, index++) {
          previous = setupChange(base, previous, variants[index % variants.length]);
          if (name !== "recovery") autoRunKey();
          await wait(
            Math.max(0, scheduled + Math.min(elapsed + cadence, duration) - performance.now()),
          );
        }
        end();
        // Let the valid edits' debounce settle before exercising malformed source.
        if (name !== "recovery") {
          start(`setup-after-${name}`);
          await wait(340);
          end();
          if (document.querySelector(".error-notification")) {
            throw new Error(`Sketch execution failed during Setup ${name} edits`);
          }
        }
        previous = setupChange(base, previous, { code: "", call: null });
      }
    } finally {
      if (view.state.doc.length > base) {
        view.dispatch({ changes: { from: base, to: view.state.doc.length } });
      }
      tab("main");
    }
    return observations;
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
      timing = options.timing;
      enabled = options.enabled;
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
        if (phase) {
          const duration = performance.now() - started;
          const data = phases[phase];
          data.dispatchMs.push(duration);
          if (operation) {
            data.operations ??= {};
            data.operations[operation] ??= [];
            data.operations[operation].push(duration);
          }
        }
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
      await wait(timing.warmMs);
      const canvas = document.querySelector("#hydra-canvas canvas");
      if (!runs.length || !draws || canvas.width !== 1280 || canvas.height !== 720) {
        throw new Error(
          `Workload did not start: runs=${runs.length} draws=${draws} canvas=${canvas.width}x${canvas.height}`,
        );
      }
      return {
        webgl,
        pageVisible: document.visibilityState === "visible",
        screen: [screen.width, screen.height],
        devicePixelRatio,
        width: canvas.width,
        height: canvas.height,
        mode: host.getStatus(pluginId),
        autoRun: options.autoRun,
      };
    },
    readHint() {
      const dom = hint();
      if (!dom) return null;
      return {
        label: dom.querySelector(".cm-signature-label")?.textContent ?? null,
        active: dom.querySelector("strong")?.textContent ?? null,
        summary: dom.querySelector(".cm-signature-summary")?.textContent ?? null,
        argument: dom.querySelector(".cm-signature-parameter")?.textContent ?? null,
      };
    },
    async cold() {
      view.focus();
      const [, position] = positions();
      start("cold");
      view.dispatch({ selection: { anchor: position + 1 } });
      await frame();
      await frame();
      end();
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
      await wait(timing.idleMs);
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
      const cadence = 70;
      const batches = Math.ceil(timing.editMs / cadence);
      const scheduled = performance.now();
      phases.editing.latenessMs = [];
      for (let batch = 0; batch < batches; batch++) {
        phases.editing.latenessMs.push(
          Math.max(0, performance.now() - scheduled - batch * cadence),
        );
        for (const [index, position] of targets.entries()) {
          if (fixture.setupScenarios) operation = ["native", "custom", "nested"][index];
          probe.operation = operation;
          edit(position);
        }
        operation = null;
        probe.operation = null;
        // The real auto-run listener receives one key event per valid edit batch.
        autoRunKey();
        await wait(
          Math.max(
            0,
            scheduled + Math.min((batch + 1) * cadence, timing.editMs) - performance.now(),
          ),
        );
      }
      end();

      start("after-edit");
      await wait(420);
      end();

      const setupObservations = fixture.setupScenarios ? await setupEditing() : null;
      start("tab");
      for (let iteration = 0; iteration < 4; iteration++) {
        tab("setup");
        view.dispatch({
          selection: {
            anchor: fixture.setupCursor ?? fixture.setup.indexOf("benchClamp(0.4,") + 16,
          },
        });
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
      view.focus();
      return {
        phases,
        runs,
        cache: probe.events,
        visibility,
        setupObservations,
        modeAfter: window.hydractrl.plugins.getStatus(pluginId),
      };
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
        view.dispatch({
          selection: {
            anchor: fixture.setupCursor ?? fixture.setup.indexOf("benchClamp(0.4,") + 16,
          },
        });
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
      return {
        mode: host.getStatus(pluginId),
        tooltip: Boolean(hint()),
        extension: extensionStatus(),
        autoRun: host.getStatus("auto-run") === "active",
      };
    },
  };
})();

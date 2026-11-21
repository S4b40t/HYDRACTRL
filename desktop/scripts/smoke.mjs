#!/usr/bin/env node
/**
 * End-to-end smoke test of the desktop app, driven through the main process's
 * own inspector, so no browser-automation dependency is needed. It launches
 * the app, waits for the server and the interface, exercises the output
 * controls, media files dropped on the editor, the settings window, settings
 * persistence and menu sync, then quits and verifies the server was stopped.
 *
 * Usage:
 *   node scripts/smoke.mjs                     packaged directory build (dist/<platform>-unpacked)
 *   node scripts/smoke.mjs --dev               development mode (electron .)
 *   node scripts/smoke.mjs --executable <app>  a specific executable
 *   --software-gl      use SwiftShader (headless Linux CI without a GPU)
 *   --no-gpu           start without the GPU, for machines where not even
 *                      SwiftShader runs (the Intel macOS runners): check
 *                      everything but the interface's own start, which needs
 *                      WebGL
 *   --optional-output  report a Syphon or Spout output that doesn't start as a
 *                      warning, not a failure (hosted CI runners have no GPU)
 *
 * On Linux without a display, run under `xvfb-run -a`. Exits 1 on any failure.
 */
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSignatureEditor } from "./signature-test-editor.mjs";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const testSender = "HYDRACTRL Signature Assist TEST";
const acceptedHash = "df17224268f1da046489749f7bc58dd37aaf4130a62763b3bfd346388b5944c5";
const dummySlot = "osc(9, 0.12, 0.4).out()";
// A 1×1 PNG, for the media checks
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const results = [];
let failures = 0;
let warnings = 0;
function check(name, ok, detail = "", { optional = false } = {}) {
  const verdict = ok ? "PASS" : optional ? "WARN" : "FAIL";
  results.push(`${verdict} ${name}${detail ? ` (${detail})` : ""}`);
  console.log(results.at(-1));
  if (ok) return;
  if (optional) warnings += 1;
  else failures += 1;
}

function findPackagedExecutable() {
  const dist = join(desktopDir, "dist");
  if (!existsSync(dist)) return null;
  const entries = readdirSync(dist);
  if (process.platform === "darwin") {
    const macDir = entries.find((e) => e.startsWith("mac"));
    return macDir ? join(dist, macDir, "HYDRACTRL.app", "Contents", "MacOS", "HYDRACTRL") : null;
  }
  if (process.platform === "win32") {
    return join(dist, "win-unpacked", "HYDRACTRL.exe");
  }
  return join(dist, "linux-unpacked", "hydractrl-desktop");
}

function resolveLaunch() {
  const dev = flag("--dev");
  const custom = option("--executable");
  if (custom) return { executable: resolve(custom), appArgs: [], mode: "custom" };
  if (dev) {
    const electronPath = join(desktopDir, "node_modules", "electron", "path.txt");
    const binary = join(
      desktopDir,
      "node_modules",
      "electron",
      "dist",
      readFileSync(electronPath, "utf8").trim(),
    );
    return { executable: binary, appArgs: ["."], mode: "dev" };
  }
  const packaged = findPackagedExecutable();
  return { executable: packaged, appArgs: [], mode: "packaged" };
}

async function main() {
  if (typeof WebSocket === "undefined") {
    console.error("smoke: needs Node.js 22 or later (for its built-in WebSocket)");
    process.exit(1);
  }
  const launch = resolveLaunch();
  if (!launch.executable || !existsSync(launch.executable)) {
    console.error(
      `smoke: executable not found (${launch.executable}). Build with "bun run pack" or pass --dev.`,
    );
    process.exit(1);
  }
  const signatureTest = flag("--signature-test");
  if (
    signatureTest &&
    (launch.mode === "dev" ||
      flag("--no-gpu") ||
      flag("--software-gl") ||
      flag("--optional-output"))
  ) {
    throw new Error("Use the packaged hardware build with mandatory Spout checks.");
  }
  const persistenceOnly = flag("--persistence-only");
  const sustain = flag("--sustain");
  const fixture = signatureTest
    ? await (
        await import("../../scripts/signature-assist-benchmark/targeted.mjs")
      ).loadTargetedFixture(process.env.BENCH_FIXTURE)
    : null;
  const userData = signatureTest
    ? join(dirname(launch.executable), "signature-test-data", "smoke")
    : mkdtempSync(join(tmpdir(), "hydractrl-smoke-"));
  // Files to drop, and a second media folder, outside the app's data folder
  const mediaFiles = signatureTest
    ? join(userData, "test-input")
    : mkdtempSync(join(tmpdir(), "hydractrl-smoke-files-"));
  if (signatureTest) mkdirSync(mediaFiles, { recursive: true });
  const chromiumFlags = [`--user-data-dir=${userData}`, "--inspect=0"];
  if (signatureTest) chromiumFlags.push("--signature-assist-test-profile=smoke");
  else chromiumFlags.push("--no-sandbox");
  const noGpu = flag("--no-gpu");
  if (noGpu) chromiumFlags.push("--disable-gpu");
  else if (flag("--software-gl")) {
    chromiumFlags.push(
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    );
  }
  const spawnArgs =
    launch.mode === "dev"
      ? [...chromiumFlags, ...launch.appArgs]
      : [...chromiumFlags, ...launch.appArgs];
  console.log(`smoke: launching ${launch.mode} build: ${launch.executable}`);
  const child = spawn(launch.executable, spawnArgs, {
    cwd: desktopDir,
    env: { ...process.env, XDG_CONFIG_HOME: join(userData, "xdg"), ELECTRON_ENABLE_LOGGING: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let wsUrl = null;
  const onData = (data) => {
    const text = String(data);
    output += text;
    const match = text.match(/ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+/);
    if (match && !wsUrl) wsUrl = match[0];
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  let exited = false;
  const exitPromise = new Promise((resolve) =>
    child.on("exit", (code) => {
      exited = true;
      resolve(code);
    }),
  );

  const printOutputTail = () => {
    if (output)
      console.log(`--- app output (tail) ---\n${output.split("\n").slice(-30).join("\n")}`);
    const logFile = join(userData, "logs", "hydractrl-desktop.log");
    if (existsSync(logFile)) {
      const log = readFileSync(logFile, "utf8").trim().split("\n").slice(-20).join("\n");
      console.log(`--- app log (tail) ---\n${log}`);
    }
  };
  const deadline = setTimeout(
    () => {
      check("finished within 4 minutes", false);
      printOutputTail();
      finish();
    },
    sustain ? 1200000 : 240000,
  );

  async function finish() {
    clearTimeout(deadline);
    if (!exited) {
      child.kill();
      await Promise.race([exitPromise, sleep(5000)]);
      if (!exited) child.kill("SIGKILL");
    }
    if (!signatureTest) {
      rmSync(userData, { recursive: true, force: true });
      rmSync(mediaFiles, { recursive: true, force: true });
    }
    const passed = results.length - failures - warnings;
    const warned = warnings > 0 ? `, ${warnings} optional check(s) failed` : "";
    console.log(`\nsmoke: ${passed}/${results.length} checks passed${warned}`);
    process.exit(failures > 0 ? 1 : 0);
  }

  try {
    for (let i = 0; i < 150 && !wsUrl && !exited; i++) await sleep(200);
    check("main process inspector reachable", Boolean(wsUrl));
    if (!wsUrl) throw new Error(`no inspector url in output:\n${output.slice(-800)}`);

    const ws = new WebSocket(wsUrl);
    await new Promise((resolveOpen, rejectOpen) => {
      ws.onopen = resolveOpen;
      ws.onerror = () => rejectOpen(new Error("inspector connection failed"));
    });
    let nextId = 1;
    const pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    };
    const send = (method, params) =>
      new Promise((resolveSend, rejectSend) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectSend(new Error(`inspector timeout: ${method}`));
        }, 20000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolveSend(message);
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    await send("Runtime.enable");

    /** Run an async snippet in the main process with electron's app, BrowserWindow and Menu in scope. */
    const inMain = async (body) => {
      const expression = `(async () => { const requireElectron = process.getBuiltinModule("module").createRequire(process.execPath); const { app, BrowserWindow, Menu, session } = requireElectron("electron"); ${body} })()`;
      const response = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      const details = response.result?.exceptionDetails;
      if (details)
        throw new Error(details.exception?.description || details.text || "evaluate failed");
      return response.result?.result?.value;
    };
    const windowTitles = () =>
      inMain("return BrowserWindow.getAllWindows().map((w) => w.getTitle());");
    // The interface's window is the first one the app opens. On macOS and
    // Windows the output renders in an offscreen window of its own, which
    // can come first in getAllWindows().
    const MAIN_WINDOW =
      "BrowserWindow.getAllWindows().filter((w) => !w.webContents.isOffscreen()).sort((a, b) => a.id - b.id)[0]";
    const SETTINGS_WINDOW =
      'BrowserWindow.getAllWindows().find((w) => w.getTitle() === "Output Settings")';
    const OUTPUT_WINDOW = "BrowserWindow.getAllWindows().find((w) => w.webContents.isOffscreen())";
    const inWindow = (finder, name, code) =>
      inMain(
        `const w = ${finder}; if (!w) throw new Error("no ${name} window"); return w.webContents.executeJavaScript(${JSON.stringify(code)});`,
      );
    const inMainWindow = (code) => inWindow(MAIN_WINDOW, "main", code);
    const inSettings = (code) => inWindow(SETTINGS_WINDOW, "settings", code);
    const inOutput = (code) => inWindow(OUTPUT_WINDOW, "output", code);
    const mirrorStatus = () =>
      inMainWindow('window.hydractrl.plugins.getApi("desktop-mirror")?.getStatus() ?? null');
    /** Put a sketch in the editor and press Run, the way a person would. */
    const runInEditor = (code) =>
      inMainWindow(`(() => {
        const editor = window._editorProxy;
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: ${JSON.stringify(code)} } });
        document.getElementById("run-btn").click();
        return true;
      })()`);
    const outputSketch = () =>
      inOutput("(window.hydractrlOutput && window.hydractrlOutput.lastSketch()?.main) || null");
    const getState = () => inMainWindow("window.hydractrlDesktop.getState()");
    /** Drop files at a point of a window, the way the OS does, through the DevTools protocol. */
    const dropFiles = (finder, files, point) =>
      inMain(`
        const w = ${finder};
        const debug = w.webContents.debugger;
        if (!debug.isAttached()) debug.attach("1.3");
        const data = { items: [], files: ${JSON.stringify(files)}, dragOperationsMask: 1 };
        try {
          for (const type of ["dragEnter", "dragOver", "drop"]) {
            await debug.sendCommand("Input.dispatchDragEvent", { type, x: ${point.x}, y: ${point.y}, data });
          }
        } finally {
          debug.detach();
        }
        return true;`);
    /** Status and body of a file the server serves. */
    const fetchMedia = async (path, headers = {}) => {
      const response = await fetch(`${(await getState()).server.url}${path}`, { headers });
      return {
        status: response.status,
        type: response.headers.get("content-type"),
        bytes: Buffer.from(await response.arrayBuffer()),
      };
    };

    // Startup: loading screen, then the interface from the local server. The
    // inspector answers while Node is still starting, before require exists,
    // so the first polls may fail.
    let firstUrl = "";
    for (let i = 0; i < 80 && !firstUrl && !exited; i++) {
      firstUrl = await inMain(
        `const w = ${MAIN_WINDOW}; return w ? w.webContents.getURL() : "";`,
      ).catch(() => "");
      if (!firstUrl) await sleep(250);
    }
    check(
      "first page is the loading screen or the interface",
      /loading\.html|127\.0\.0\.1/.test(String(firstUrl)),
      String(firstUrl),
    );
    // Without a GPU the interface can't start hydra, so only wait for the page
    // and the desktop bridge
    const readyProbe = noGpu
      ? 'typeof window.hydractrlDesktop === "object"'
      : "Boolean(window.hydractrl && window.hydractrl.plugins)";
    let ready = false;
    for (let i = 0; i < 360 && !ready && !exited; i++) {
      ready = await inMain(
        `const w = ${MAIN_WINDOW}; if (!w || !w.webContents.getURL().startsWith("http://127.0.0.1:")) return false; return w.webContents.executeJavaScript(${JSON.stringify(readyProbe)}).catch(() => false);`,
      ).catch(() => false);
      if (!ready) await sleep(250);
    }
    check(
      noGpu
        ? "interface page loaded from the local server"
        : "interface loaded from the local server",
      ready,
      exited ? "the app exited" : "",
    );
    if (!ready) throw new Error("interface did not load");
    await sleep(1000);

    const state = await getState();
    check(
      "server ready",
      state.server.status === "ready" && Boolean(state.server.url),
      JSON.stringify(state.server),
    );
    check(
      "app mode reported",
      state.app.packaged === (signatureTest || launch.mode === "packaged"),
      `packaged=${state.app.packaged}`,
    );
    const expectAvailable = process.platform === "darwin" || process.platform === "win32";
    check(
      "output availability matches the platform",
      state.output.available === expectAvailable,
      state.output.available ? state.output.protocol : state.output.unavailableReason,
    );
    check(
      "settings are the defaults",
      signatureTest
        ? state.settings.output.name === testSender &&
            !state.settings.output.autoStart &&
            state.settings.output.includeAlpha &&
            (sustain ||
              persistenceOnly ||
              (state.settings.output.width === 1280 &&
                state.settings.output.height === 720 &&
                state.settings.output.frameRate === 60))
        : state.settings.output.name === "HYDRACTRL" && state.settings.output.width === 1920,
    );
    if (signatureTest) {
      const paths = await inMain(
        'return [app.getPath("userData"), app.getPath("sessionData"), session.defaultSession.storagePath, app.getPath("crashDumps")];',
      );
      check(
        "profile, Chromium storage and crash dumps are isolated",
        paths.slice(0, 3).every((value) => value === userData) &&
          paths[3] === join(userData, "crash-dumps") &&
          state.app.logPath.startsWith(join(userData, "logs")),
        JSON.stringify(paths),
      );
      check(
        "owned packaged server on fixed loopback port",
        state.server.mode === "spawned" &&
          state.server.pid > 0 &&
          state.server.url === "http://127.0.0.1:43130" &&
          !state.settings.server.allowNetwork,
        JSON.stringify(state.server),
      );
      const renderer = await inMainWindow(`(() => {
        const gl = document.querySelector("#hydra-canvas canvas").getContext("webgl");
        const ext = gl?.getExtension("WEBGL_debug_renderer_info");
        return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
      })()`);
      check(
        "hardware WebGL renderer",
        Boolean(renderer) && !/swiftshader|software|warp|basic render/i.test(renderer),
        renderer,
      );
      const log = readFileSync(state.app.logPath, "utf8");
      check(
        "packaged and served client hash verified",
        log.includes(`Verified packaged and served client SHA-256 ${acceptedHash}`),
      );
    }

    async function quitTest() {
      const owned = await inMain("return app.getAppMetrics().map(({pid})=>pid);");
      await inMain("setTimeout(() => app.quit(), 800); return true;");
      ws.close();
      const code = await Promise.race([exitPromise, sleep(20000).then(() => "timeout")]);
      check("app quits cleanly", code === 0, `exit ${code}`);
      const reachable = await fetch(`${state.server.url}/api/capabilities`).then(
        () => true,
        () => false,
      );
      check("owned server port released", !reachable, state.server.url);
      await sleep(500);
      const live = [...new Set([...owned, state.server.pid])].filter((pid) => {
        if (!pid) return false;
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
      check("owned renderer, GPU and server processes stopped", live.length === 0, live.join(","));
    }

    if (signatureTest && persistenceOnly) {
      const slot = await inMainWindow('localStorage.getItem("hydractrl-slot-bank-0-slot-0")');
      const media = await fetchMedia("/media/smoke%20pixel.png");
      check("dummy scene bank persisted through restart", slot === dummySlot);
      check(
        "isolated media persisted through restart",
        media.status === 200 && media.bytes.equals(PIXEL_PNG),
      );
      check(
        "test settings persisted through restart",
        (await getState()).settings.output.width === 16,
      );
      await quitTest();
      return finish();
    }

    if (signatureTest && sustain) {
      await inMainWindow(`window.hydractrlDesktop.updateSettings({
        output:{ width:1280,height:720,frameRate:60,includeAlpha:true,preview:false },
      })`);
      await inMainWindow(`(() => {
        document.querySelector('.editor-tab[data-tab="setup"]').click();
        const editor=window._editorProxy;
        editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:${JSON.stringify(fixture.setup)}}});
        document.querySelector('.editor-tab[data-tab="main"]').click();
        window.__desktopSustainErrors=[];
        window.addEventListener("error", (event)=>window.__desktopSustainErrors.push(event.message));
        window.addEventListener("unhandledrejection", ()=>window.__desktopSustainErrors.push("unhandled rejection"));
      })()`);
      await runInEditor(fixture.sketch);
      check(
        "Spout starts for sustained smoke",
        await inMainWindow("window.hydractrlDesktop.startOutput()"),
      );
      const began = Date.now();
      const samples = [];
      const outputFile = process.env.SUSTAIN_RESULT;
      if (!outputFile) throw new Error("Set SUSTAIN_RESULT to a new local JSON path.");
      writeFileSync(outputFile, "[]", { flag: "wx" });
      const sketches = [fixture.sketch, fixture.sketch.replace("osc(12,", "osc(9,")];
      while (Date.now() - began < 15 * 60 * 1000) {
        const sketch = sketches[samples.length % sketches.length];
        const dispatchMs = await inMainWindow(`(() => {
          const code=${JSON.stringify(sketch)};
          const view=document.querySelector(".cm-content").cmView.rootView.view;
          view.focus();
          const start = performance.now();
          view.dispatch({changes:{from:0,to:view.state.doc.length,insert:code},
            selection:{anchor:code.indexOf("clamp(0.5,")+"clamp(0.5,".length}});
          return performance.now() - start;
        })()`);
        await sleep(300);
        const tooltip = await inMainWindow(
          'document.querySelector(".cm-signature-assist strong")?.textContent ?? null',
        );
        await inMainWindow('document.getElementById("run-btn").click()');
        await sleep(14700);
        const current = await getState();
        const metrics = await inMain("return app.getAppMetrics();");
        const heap = await inMainWindow("performance.memory?.usedJSHeapSize ?? null");
        const errors = await inMainWindow("window.__desktopSustainErrors");
        samples.push({
          elapsedMs: Date.now() - began,
          output: current.output,
          metrics,
          heap,
          dispatchMs,
          tooltip: tooltip === fixture.customHint.active,
          scene: (await outputSketch()) === sketch,
          runtimeErrors: errors.length,
        });
        writeFileSync(outputFile, JSON.stringify(samples));
        if (samples.length % 10 === 0)
          console.log(`sustain: ${samples.length} samples, Spout ${current.output.fps} fps`);
      }
      check(
        "sustained renderer stayed running",
        samples.every((x) => x.output.state === "running" && x.output.fps > 0),
      );
      check(
        "scene changes arrived at the output",
        samples.every((x) => x.scene),
      );
      check(
        "sustained editor retained Signature Assist",
        samples.every((x) => x.tooltip),
      );
      check(
        "no sustained editor runtime errors",
        samples.every((x) => x.runtimeErrors === 0),
      );
      await quitTest();
      return finish();
    }

    if (noGpu) {
      console.log("SKIP interface plugins and the OUTPUT block (they need WebGL)");
    } else {
      const plugins = await inMainWindow("window.hydractrl.plugins.list()");
      check(
        "all interface plugins active",
        plugins.every((p) => p.status === "active") &&
          plugins.some((p) => p.id === "desktop-output"),
        plugins
          .filter((p) => p.status !== "active")
          .map((p) => p.id)
          .join(",") || `${plugins.length} plugins`,
      );
      const block = await inMainWindow(
        '(document.querySelector(".desktop-output") || {}).innerText || ""',
      );
      check("OUTPUT block in the stats panel", /OUTPUT/.test(block), block.replace(/\n/g, " | "));
      const mirrorSetup = await inMainWindow(
        '({ receiver: typeof window.hydractrlDesktop.mirror?.start === "function", status: window.hydractrl.plugins.getApi("desktop-mirror")?.getStatus() ?? null })',
      );
      check(
        "the interface can receive the output's frames",
        mirrorSetup.receiver && mirrorSetup.status !== null,
        JSON.stringify(mirrorSetup),
      );
    }

    const outputMenu = await inMain(
      'const menu = Menu.getApplicationMenu().items.find((i) => i.label === "Output"); return menu ? menu.submenu.items.map((i) => ({ label: i.label, enabled: i.enabled })) : null;',
    );
    check(
      "Output menu present",
      Array.isArray(outputMenu) && outputMenu.some((i) => i.label === "Resolution"),
    );
    check(
      "Output toggle enabled state matches availability",
      outputMenu?.[0]?.enabled === expectAvailable,
      JSON.stringify(outputMenu?.[0]),
    );

    if (expectAvailable) {
      const started = await inMainWindow("window.hydractrlDesktop.startOutput()");
      let running = null;
      for (let i = 0; i < 40; i++) {
        running = (await getState()).output;
        if (running.state === "running" && running.fps !== null) break;
        await sleep(250);
      }
      const optional = flag("--optional-output");
      const framesFlow = started && running.state === "running" && running.fps > 0;
      check(
        "output starts and reports fps",
        framesFlow,
        JSON.stringify({ state: running.state, fps: running.fps, error: running.error }),
        { optional },
      );
      if (signatureTest && framesFlow) {
        check(
          "Spout uses test sender, 720p60 and alpha",
          running.protocol === "Spout" &&
            running.name === testSender &&
            running.width === 1280 &&
            running.height === 720 &&
            running.frameRate === 60 &&
            running.includeAlpha,
          JSON.stringify(running),
        );
        await inMainWindow("window.hydractrlDesktop.updateSettings({output:{preview:true}})");
        await sleep(500);
        check("Spout preview opens", (await getState()).output.previewOpen);
        const outputProfiles = await inMain(
          "return BrowserWindow.getAllWindows().map(w=>w.webContents.session.storagePath);",
        );
        check(
          "all Electron windows use isolated or in-memory session storage",
          outputProfiles.every((value) => value === null || value === userData),
        );
        check("Spout restarts", await inMainWindow("window.hydractrlDesktop.restartOutput()"));
        await sleep(800);
        check("restarted Spout resumes frames", (await getState()).output.fps > 0);
      }

      // The interface shows the output's own frames instead of rendering
      // again, and runs sketches there
      let mirrored = null;
      if (framesFlow && !noGpu) {
        for (let i = 0; i < 60; i++) {
          mirrored = await mirrorStatus();
          if (mirrored?.active) break;
          await sleep(250);
        }
        check(
          "the interface shows the output's own frames",
          Boolean(mirrored?.active) && (await getState()).output.mirror === true,
          JSON.stringify(mirrored),
          { optional },
        );
      }
      if (mirrored?.active) {
        await runInEditor("osc(7, 0.1, 1.2).out()");
        let ran = null;
        for (let i = 0; i < 40 && ran !== "osc(7, 0.1, 1.2).out()"; i++) {
          await sleep(250);
          ran = await outputSketch();
        }
        check("a run plays on the output", ran === "osc(7, 0.1, 1.2).out()", String(ran));
        await runInEditor("osc(7, 0.1, 1.2).out(");
        await sleep(1500);
        const error = await inMainWindow(
          '(document.querySelector(".error-notification") || {}).innerText || ""',
        );
        check(
          "a broken sketch shows its error and leaves the output playing",
          error.length > 0 && (await outputSketch()) === "osc(7, 0.1, 1.2).out()",
          error.split("\n")[0],
        );
      }
      await inMainWindow("window.hydractrlDesktop.stopOutput()");
      await sleep(500);
      const stopped = (await getState()).output;
      check("output stops", stopped.state === "stopped", stopped.state, { optional });
      if (mirrored?.active) {
        const after = await mirrorStatus();
        const visible = await inMainWindow(
          '(document.querySelector("#hydra-canvas canvas:not([hidden])") || {}).className || "hydra"',
        );
        check(
          "the interface renders on its own again once the output stops",
          after?.active === false && visible !== "desktop-mirror",
          `${JSON.stringify(after)} ${visible}`,
        );
      }
    } else {
      const started = await inMainWindow("window.hydractrlDesktop.startOutput()");
      const after = (await getState()).output;
      check(
        "startOutput refuses gracefully when unavailable",
        started === false && after.state === "error",
        after.error,
      );
    }

    // Media: images and videos dropped on the editor go to the media folder,
    // which the server serves at /media/
    const mediaState = (await getState()).media;
    const mediaDir = join(dirname(dirname(state.app.logPath)), "media");
    check(
      "media folder defaults to the app's data folder",
      mediaState?.folder === mediaDir && mediaState.isDefault && mediaState.available,
      JSON.stringify(mediaState),
    );
    const pixel = join(mediaFiles, "smoke pixel.png");
    writeFileSync(pixel, PIXEL_PNG);
    if (noGpu) {
      // No interface to drop on: put the file in the folder by hand
      console.log("SKIP dropping a file on the editor (the interface needs WebGL)");
      mkdirSync(mediaDir, { recursive: true });
      copyFileSync(pixel, join(mediaDir, "smoke pixel.png"));
    } else {
      // The About panel covers the editor on a first start
      const point = await inMainWindow(`(() => {
        const info = document.getElementById("info-panel");
        if (info) info.style.display = "none";
        const box = document.querySelector("#editor-content .cm-content").getBoundingClientRect();
        const point = { x: Math.round(box.left + 60), y: Math.round(box.top + 8) };
        return { ...point, onEditor: Boolean(document.elementFromPoint(point.x, point.y)?.closest(".cm-editor")) };
      })()`);
      await dropFiles(MAIN_WINDOW, [pixel], point);
      const line = 's0.initImage("/media/smoke pixel.png");';
      let code = "";
      for (let i = 0; i < 40 && !code.includes(line); i++) {
        await sleep(250);
        code = await inMainWindow("window._editorProxy._editor.getCode()");
      }
      check(
        "a file dropped on the editor adds a line that loads it",
        point.onEditor && code.includes(line),
        code.split("\n").slice(0, 2).join(" | "),
      );
      check(
        "the dropped file is copied into the media folder",
        existsSync(join(mediaDir, "smoke pixel.png")) && existsSync(pixel),
      );
      const loaded = await inMainWindow(`new Promise((resolve) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => resolve(image.width);
        image.onerror = () => resolve(-1);
        image.src = "/media/smoke pixel.png";
      })`);
      check("the interface loads it the way hydra does", loaded === 1, `width ${loaded}`);
    }
    const served = await fetchMedia("/media/smoke%20pixel.png");
    check(
      "the server serves the media folder at /media/",
      served.status === 200 && served.type === "image/png" && served.bytes.equals(PIXEL_PNG),
      `${served.status} ${served.type}`,
    );
    const ranged = await fetchMedia("/media/smoke%20pixel.png", { Range: "bytes=0-7" });
    check("media answers byte ranges", ranged.status === 206 && ranged.bytes.length === 8);

    const otherFolder = join(mediaFiles, "other media");
    mkdirSync(otherFolder, { recursive: true });
    writeFileSync(join(otherFolder, "other.png"), PIXEL_PNG);
    const pidBeforeSwitch = (await getState()).server.pid;
    await inMainWindow(
      `window.hydractrlDesktop.updateSettings({ media: { folder: ${JSON.stringify(otherFolder)} } }).then(() => true)`,
    );
    let switched = null;
    for (let i = 0; i < 20 && switched?.status !== 200; i++) {
      await sleep(150);
      switched = await fetchMedia("/media/other.png");
    }
    const oldFile = await fetchMedia("/media/smoke%20pixel.png");
    check(
      "the server follows a new media folder without restarting",
      switched?.status === 200 &&
        oldFile.status === 404 &&
        (await getState()).server.pid === pidBeforeSwitch,
      `new ${switched?.status}, old ${oldFile.status}`,
    );
    await inMainWindow(
      'window.hydractrlDesktop.updateSettings({ media: { folder: "" } }).then(() => true)',
    );
    let restored = null;
    for (let i = 0; i < 20 && restored?.status !== 200; i++) {
      await sleep(150);
      restored = await fetchMedia("/media/smoke%20pixel.png");
    }
    check("Use Default goes back to the app's media folder", restored?.status === 200);

    if (signatureTest && !noGpu) {
      await checkSignatureEditor({
        check,
        inMain,
        inMainWindow,
        mainWindow: MAIN_WINDOW,
        fixture,
        sleep,
      });
      const audio = await inMainWindow(
        'window.hydractrl.plugins.getApi("audio-input")?.choose(null)',
      );
      check("isolated editor accepts system-default audio selection", audio?.choice === null);
      await inMainWindow(`(() => {
        localStorage.setItem("hydractrl-slot-bank-0-slot-0",${JSON.stringify(dummySlot)});
        document.querySelector('.slot[data-index="0"]').click();
      })()`);
      check(
        "Signature Assist remains active after loading a dummy slot",
        (await inMainWindow('window.hydractrl.plugins.getStatus("signature-assist")')) === "active",
      );
    }

    // Settings window
    await inMainWindow('window.hydractrlDesktop.openSettings("resolution")');
    let serverText = "";
    for (let i = 0; i < 60 && !String(serverText).startsWith("http"); i++) {
      await sleep(250);
      serverText = await inSettings('document.getElementById("server-url").textContent').catch(
        () => "",
      );
    }
    check(
      "settings window opened and shows the server address",
      String(serverText).startsWith("http://127.0.0.1:"),
      String(serverText),
    );
    await inSettings('document.querySelector("label:has(#allowNetwork) .track").click(); true');
    await sleep(400);
    check(
      signatureTest ? "test profile refuses LAN access" : "switch toggles a server setting",
      (await inSettings('document.getElementById("allowNetwork").checked')) === !signatureTest,
    );
    await inSettings(
      'window.hydractrlDesktop.updateSettings({ output: { name: "SmokeTest", width: 3840, height: 2160, frameRate: 30 } }).then(() => true)',
    );
    await sleep(600);
    const stateAfter = await getState();
    const settingsFile = join(dirname(dirname(stateAfter.app.logPath)), "settings.json");
    const saved = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : null;
    check(
      "settings persisted to disk",
      saved?.output?.name === (signatureTest ? testSender : "SmokeTest") &&
        saved?.output?.width === 3840 &&
        saved?.server?.allowNetwork === !signatureTest,
      settingsFile,
    );
    const rendered = await inSettings(
      'JSON.stringify({ name: document.getElementById("name").value, preset: document.getElementById("preset").value, rate: document.getElementById("frameRate").value })',
    );
    check(
      "settings window re-rendered from state",
      rendered ===
        JSON.stringify({
          name: signatureTest ? testSender : "SmokeTest",
          preset: "3840x2160",
          rate: "30",
        }),
      rendered,
    );
    const checked = await inMain(
      'const menu = Menu.getApplicationMenu().items.find((i) => i.label === "Output"); const res = menu.submenu.items.find((i) => i.label === "Resolution").submenu.items.find((i) => i.checked); const rate = menu.submenu.items.find((i) => i.label === "Frame Rate").submenu.items.find((i) => i.checked); return { res: res && res.label, rate: rate && rate.label };',
    );
    check(
      "menu checkmarks follow settings",
      /4K/.test(String(checked.res)) && checked.rate === "30 fps",
      JSON.stringify(checked),
    );
    const clamped = await inMainWindow(
      'window.hydractrlDesktop.updateSettings({ output: { width: -5, name: "" } })',
    );
    check(
      "invalid settings are clamped",
      clamped.output.width === 16 &&
        clamped.output.name === (signatureTest ? testSender : "SmokeTest"),
      JSON.stringify(clamped.output),
    );
    const mediaRow = await inSettings(
      'JSON.stringify({ text: document.getElementById("media-folder").textContent, title: document.getElementById("media-folder").title })',
    );
    check(
      "settings window shows the media folder",
      JSON.parse(mediaRow).title === mediaDir && JSON.parse(mediaRow).text.endsWith("media"),
      mediaRow,
    );
    await sleep(2000);
    check(
      "settings window still open after updates",
      (await windowTitles()).includes("Output Settings"),
    );
    await inSettings(
      'document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); true',
    );
    await sleep(800);
    check("Escape closes the settings window", !(await windowTitles()).includes("Output Settings"));

    // Quit and verify cleanup
    const serverPid = stateAfter.server.pid;
    const logPath = stateAfter.app.logPath;
    // Detach the inspector before quitting: an attached debugger session keeps
    // the process alive after Electron's quit sequence has run.
    await inMain("setTimeout(() => app.quit(), 800); return true;");
    ws.close();
    const code = await Promise.race([exitPromise, sleep(20000).then(() => "timeout")]);
    check("app quits cleanly", code === 0, `exit ${code}`);
    await sleep(1000);
    if (serverPid) {
      let alive = true;
      try {
        process.kill(serverPid, 0);
      } catch {
        alive = false;
      }
      check("server process stopped on quit", !alive, `pid ${serverPid}`);
    }
    let portFree = false;
    try {
      await fetch(`${stateAfter.server.url}/api/capabilities`);
    } catch {
      portFree = true;
    }
    check(
      "server port released on quit",
      portFree || stateAfter.server.mode === "attached",
      stateAfter.server.url,
    );
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    check(
      "log records startup and shutdown",
      /starting \(/.test(log) && /shutting down/.test(log),
      logPath,
    );
    check(
      "the main process took the interface's request for frames",
      !noGpu ? !/desktop:set-mirror failed/.test(log) : true,
      (log.match(/desktop:set-mirror failed.*/) || [""])[0],
    );
    ws.close();
  } catch (error) {
    check("smoke test completed", false, String(error.message || error).slice(0, 300));
    printOutputTail();
  }
  await finish();
}

main();

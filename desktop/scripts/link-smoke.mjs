import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { LINK_TEST_SCENE } from "../../src/client/plugins/linkTestScene.js";

async function until(read, timeout = 14000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await read().catch(() => null);
    if (value) return value;
    await sleep(100);
  }
  return null;
}

export function linkHelperPid(logPath) {
  const log = readFileSync(logPath, "utf8");
  return Number([...log.matchAll(/\[link\] helper started \(PID (\d+),/g)].at(-1)?.[1] || 0);
}

export async function runLinkSmoke({
  peerPath,
  check,
  inMainWindow,
  inOutput,
  inSettings,
  runInEditor,
  getState,
  restartOutput,
  optionalOutput,
  noGpu,
}) {
  const state = await getState();
  const logPath = state.app.logPath;
  const diagnostics = () => inSettings("window.hydractrlLinkSettings.diagnostics()");
  const enabled = (value) =>
    inSettings(`window.hydractrlLinkSettings.configure({enabled:${value}})`);
  const inEditor = () => inMainWindow("window.hydractrlLink?.read() ?? null");
  const inPrimary = () => inOutput("window.hydractrlLink?.read() ?? null");
  const peer = spawn(peerPath, ["--pipe"], { windowsHide: true });
  peer.on("error", (error) => console.error(`Link peer failed ${error.message}`));
  const closed = new Promise((resolve) => peer.once("close", resolve));
  const lines = createInterface({ input: peer.stdout })[Symbol.asyncIterator]();
  peer.stderr.on("data", (line) => console.error(String(line)));
  const command = async (value) => {
    peer.stdin.write(`${value}\n`);
    return JSON.parse((await lines.next()).value);
  };

  try {
    check(
      "Link disabled by default and helper idle",
      !state.settings.link.enabled && !linkHelperPid(logPath),
    );
    const untrusted = await inMainWindow(
      "window.hydractrlDesktop.updateSettings({link:{enabled:true}}).then((s) => s.link.enabled)",
    );
    check("editor cannot configure Link", untrusted === false);
    await command("disconnect");
    await inSettings('document.getElementById("link-enabled").click(); true');
    check(
      "Link settings enable the helper",
      Boolean(await until(async () => (await diagnostics())?.enabled)),
    );
    check(
      "a running helper with no peers is local",
      Boolean(await until(async () => (await diagnostics())?.state === "local")),
    );
    await command("connect");
    const joined = await until(async () => {
      const view = await diagnostics();
      return view?.state === "synced" && view.peers > 0;
    });
    check("Electron sees a real Link SDK peer", Boolean(joined));
    if (!joined) return;

    await command("140");
    check(
      "Link follows the peer's tempo",
      Boolean(await until(async () => Math.abs((await diagnostics())?.anchor.bpm - 140) < 0.01)),
    );
    if (!noGpu) {
      check(
        "editor receives timestamped Link timing",
        Boolean(
          await until(async () => {
            const view = await inEditor();
            return view?.synced && Math.abs(view.bpm - 140) < 0.01;
          }),
        ),
      );
      await runInEditor(`${LINK_TEST_SCENE}\nglobalThis.linkSmokeSceneRan = true;`);
      check(
        "Link Test Scene runs in the local renderer",
        Boolean(await until(() => inMainWindow("globalThis.linkSmokeSceneRan === true"))),
      );
      await inMainWindow(
        "globalThis.linkSmokeOriginalDocument = true; setTimeout(() => location.reload(), 100); true",
      );
      check(
        "editor reload reacquires timing",
        Boolean(
          await until(() =>
            inMainWindow(
              "!globalThis.linkSmokeOriginalDocument && window.hydractrlLink?.read().synced",
            ),
          ),
        ),
      );
    }

    const pid = linkHelperPid(logPath);
    await inSettings("window.hydractrlLinkSettings.configure({quantum:3})");
    check(
      "quantum change preserves the helper",
      Boolean(
        await until(async () => {
          const view = await diagnostics();
          return view?.state === "synced" && view.anchor.quantum === 3;
        }),
      ) && linkHelperPid(logPath) === pid,
    );
    await inSettings("window.hydractrlLinkSettings.configure({quantum:4})");

    if (!noGpu && state.output.available) {
      await inMainWindow(
        "window.hydractrlDesktop.updateSettings({output:{width:1280,height:720}})",
      );
      const started = await inMainWindow("window.hydractrlDesktop.startOutput()");
      const view = started && (await until(async () => (await inPrimary())?.synced));
      check("the primary renderer joins the same timing service", Boolean(view), "", {
        optional: optionalOutput,
      });
      if (view) {
        const sketch = `${LINK_TEST_SCENE}\nglobalThis.linkSmokePrimarySceneRan = true;`;
        await runInEditor(sketch);
        check(
          "Link Test Scene runs in the primary renderer",
          Boolean(await until(() => inOutput("globalThis.linkSmokePrimarySceneRan === true"))),
        );
        await restartOutput();
        check(
          "Spout restart reacquires timing",
          Boolean(await until(async () => (await inPrimary())?.synced)),
        );
        await inMainWindow("window.hydractrlDesktop.stopOutput()");
        check(
          "editor fallback keeps Link timing",
          Boolean(await until(async () => (await inEditor())?.synced)),
        );
      }
    }

    await command("disconnect");
    check(
      "peer disconnect returns to local timing",
      Boolean(await until(async () => (await diagnostics())?.state === "local")),
    );
    await command("connect");
    check(
      "peer reconnect restores synchronization",
      Boolean(await until(async () => (await diagnostics())?.state === "synced")),
    );
    if (pid && linkHelperPid(logPath) === pid) process.kill(pid);
    check(
      "Electron recovers from a real helper exit",
      Boolean(
        await until(async () => {
          const nextPid = linkHelperPid(logPath);
          return nextPid && nextPid !== pid && (await diagnostics())?.state === "synced";
        }),
      ),
    );
    check(
      "Link diagnostics copy from settings",
      await inSettings("window.hydractrlLinkSettings.copyDiagnostics()"),
    );
    await enabled(false);
    check("disabling stops synchronization", (await diagnostics())?.state === "disabled");
    await enabled(true);
    check(
      "helper restarts when re-enabled",
      Boolean(await until(async () => (await diagnostics())?.state === "synced")),
    );
  } finally {
    peer.stdin.end();
    const timer = setTimeout(() => peer.kill(), 2000);
    check("Link Test Peer exits cleanly", (await closed) === 0);
    clearTimeout(timer);
  }
}

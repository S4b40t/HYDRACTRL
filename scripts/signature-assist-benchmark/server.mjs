import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { isolatedServerEnv } from "./platform.mjs";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function stopServer(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

export async function startServer(bun, cwd, port) {
  const portCheck = createServer();
  try {
    await new Promise((resolve, reject) => {
      portCheck.once("error", reject);
      portCheck.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    throw new Error(`Dedicated port ${port} is unavailable. Choose another BENCH_PORT.`, {
      cause: error,
    });
  } finally {
    if (portCheck.listening) await new Promise((resolve) => portCheck.close(resolve));
  }

  const child = spawn(bun, ["src/index.ts"], {
    cwd,
    env: isolatedServerEnv(process.env, port),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  try {
    await new Promise((resolve, reject) => {
      let logs = "";
      const timer = setTimeout(
        () => reject(new Error(`Server startup timed out: ${logs}`)),
        15_000,
      );
      function done(error) {
        clearTimeout(timer);
        child.off("error", done);
        child.off("exit", earlyExit);
        error ? reject(error) : resolve();
      }
      function earlyExit(code) {
        done(new Error(`Benchmark server exited (${code}): ${logs}`));
      }
      function read(chunk) {
        logs = (logs + chunk).slice(-4000);
        if (logs.includes(`Server running at http://localhost:${port} `)) done();
      }
      child.once("error", done);
      child.once("exit", earlyExit);
      child.stdout.on("data", read);
      child.stderr.on("data", (chunk) => {
        logs = (logs + chunk).slice(-4000);
      });
    });
    if (child.exitCode !== null) throw new Error("Benchmark server stopped after startup");
    return child;
  } catch (error) {
    await stopServer(child);
    throw error;
  }
}

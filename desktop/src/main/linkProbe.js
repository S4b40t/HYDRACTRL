import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { estimateLinkTiming, measureLinkClock } from "./linkTiming.js";

const POLL_MS = 50;
const REPLY_TIMEOUT_MS = 2000;
const EXIT_TIMEOUT_MS = 1000;

function parseSample(line) {
  const sample = JSON.parse(line);
  if (
    sample?.version !== 1 ||
    !Number.isSafeInteger(sample.hostUs) ||
    !Number.isFinite(sample.bpm) ||
    sample.bpm < 20 ||
    sample.bpm > 999 ||
    !Number.isFinite(sample.beat) ||
    !Number.isFinite(sample.phase) ||
    !Number.isFinite(sample.quantum) ||
    sample.quantum < 0.001 ||
    sample.quantum > 64 ||
    sample.phase < 0 ||
    sample.phase >= sample.quantum ||
    !Number.isSafeInteger(sample.peers) ||
    sample.peers < 0 ||
    !Number.isSafeInteger(sample.tempoRevision) ||
    sample.tempoRevision < 0 ||
    sample.enabled !== true
  ) {
    throw new Error("invalid Link timing snapshot");
  }
  return sample;
}

/** The child owns discovery and stdin owns its lifetime. */
export function startLinkProbe({ executable, quantum = 4, log, onSample, onError = () => {} }) {
  if (!isAbsolute(executable)) throw new Error("use an absolute path to hydractrl-link");
  const child = spawn(executable, [String(quantum)], { windowsHide: true });
  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  const offsets = [];
  let sentUs = null;
  let requestedQuantum = quantum;
  let closing = false;
  let closed = false;
  let killTimer;
  let lastSample;
  let nextLogUs = 0;

  function stop() {
    if (!closing && !closed) {
      closing = true;
      clearInterval(poll);
      child.stdin.end();
      killTimer = setTimeout(() => child.kill("SIGKILL"), EXIT_TIMEOUT_MS);
    }
    return done;
  }

  function fail(error) {
    if (!closing && !closed) {
      log.warn(`helper failed: ${error.message}`);
      onError(error.message);
    }
    stop();
  }

  const done = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      closed = true;
      clearInterval(poll);
      clearTimeout(killTimer);
      lines.close();
      if (code === 0) log.info(`helper exited (PID ${child.pid}, code 0)`);
      else log.warn(`helper exited (PID ${child.pid}, ${signal ?? `code ${code}`})`);
      resolve({ code, signal });
    });
  });

  const poll = setInterval(() => {
    const nowUs = performance.now() * 1000;
    if (sentUs !== null) {
      if (nowUs - sentUs >= REPLY_TIMEOUT_MS * 1000) fail(new Error("sample timed out"));
      return;
    }
    sentUs = nowUs;
    child.stdin.write(`sample ${requestedQuantum}\n`);
  }, POLL_MS);

  child.on("error", fail);
  child.stdin.on("error", fail);
  lines.on("error", fail);
  child.stderr.on("error", fail);
  child.stderr.setEncoding("utf8").on("data", (text) => log.warn(text.trim()));
  child.once("spawn", () => log.info(`helper started (PID ${child.pid}, quantum ${quantum})`));
  lines.on("line", (line) => {
    if (closing || closed) return;
    const receivedUs = performance.now() * 1000;
    try {
      if (sentUs === null) throw new Error("unsolicited Link timing snapshot");
      const sample = parseSample(line);
      const measurement = measureLinkClock(sentUs, receivedUs, sample.hostUs);
      sentUs = null;
      offsets.push(measurement);
      if (offsets.length > 20) offsets.shift();
      const best = offsets.reduce((a, b) => (a.roundTripUs <= b.roundTripUs ? a : b));
      const timing = estimateLinkTiming(sample, best.offsetUs, receivedUs);

      if (receivedUs >= nextLogUs || lastSample?.peers !== sample.peers) {
        const { peers, bpm, quantum, tempoRevision } = sample;
        log.info(
          `peers=${peers} bpm=${bpm.toFixed(3)} beat=${timing.beat.toFixed(3)} ` +
            `phase=${timing.phase.toFixed(3)}/${quantum} tempoRevision=${tempoRevision} ` +
            `rttMs=${(measurement.roundTripUs / 1000).toFixed(3)}`,
        );
        nextLogUs = receivedUs + 1_000_000;
      }
      lastSample = sample;
      onSample({ sample, measurement, offset: best, timing, receivedUs });
    } catch (error) {
      fail(error);
    }
  });

  return {
    pid: child.pid,
    stop,
    done,
    setQuantum(value) {
      requestedQuantum = value;
    },
  };
}

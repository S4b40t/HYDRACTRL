import { LINK_STALE_US, anchorLink, createLinkTimeline, projectLink } from "../shared/linkClock.js";
import { startLinkProbe } from "./linkProbe.js";

export function createLinkService({
  executable,
  log,
  startProbe = startLinkProbe,
  now = () => performance.now() * 1000,
  timers = { setTimeout, clearTimeout },
}) {
  let options = { enabled: false, quantum: 4 };
  let anchor = createLinkTimeline(now(), options.quantum);
  let state = "disabled";
  let sample = null;
  let error = null;
  let clockEpoch = 0;
  let running = null;
  let retry = null;
  let failures = 0;
  let suspended = false;
  let disposed = false;

  const shouldRun = () => options.enabled && executable && !suspended && !disposed;

  function fallback(next, quantum = options.quantum) {
    if (state !== next || anchor.quantum !== quantum) {
      anchor = anchorLink(anchor, now(), { bpm: anchor.bpm, quantum, reset: true });
    }
    state = next;
    sample = null;
  }

  function clearRetry() {
    if (retry !== null) timers.clearTimeout(retry);
    retry = null;
  }

  function scheduleRetry(reason) {
    if (!shouldRun()) return;
    error = reason;
    fallback("retrying");
    const delay = Math.min(250 * 2 ** Math.min(failures++, 5), 8000);
    retry = timers.setTimeout(() => {
      retry = null;
      reconcile();
    }, delay);
  }

  function accept(record, event) {
    if (running !== record || record.stopping || event.sample.quantum !== options.quantum) return;
    // A reply held up across a stall cannot establish a valid clock mapping.
    if (event.measurement.roundTripUs > LINK_STALE_US) return;
    const { bpm, peers, quantum, hostUs, tempoRevision } = event.sample;
    const synced = peers > 0;
    const expired = !sample || event.receivedUs - sample.receivedUs > LINK_STALE_US;
    const reset =
      (synced && state !== "synced") || anchor.quantum !== quantum || (synced && expired);
    const phase = synced ? event.timing.phase : undefined;
    anchor = anchorLink(anchor, event.receivedUs, { bpm, quantum, phase, reset });
    state = synced ? "synced" : "local";
    sample = {
      bpm,
      peers,
      tempoRevision,
      receivedUs: event.receivedUs,
      hostUs,
      rttUs: event.measurement.roundTripUs,
    };
    if (event.receivedUs - record.startedUs >= 5000000) failures = 0;
    error = null;
  }

  function reconcile() {
    if (!shouldRun() || running || retry !== null) return;
    const record = { stopping: false, startedUs: now(), probe: null };
    if (state !== "retrying") fallback("starting");
    try {
      record.probe = startProbe({
        executable,
        quantum: options.quantum,
        log,
        onSample: (event) => accept(record, event),
        onError(reason) {
          if (running !== record || record.stopping) return;
          error = reason;
          fallback("retrying");
        },
      });
    } catch (err) {
      scheduleRetry(err.message);
      return;
    }
    running = record;
    record.probe.done.then(({ code, signal }) => {
      running = null;
      if (record.stopping) reconcile();
      else scheduleRetry(error || `Link helper exited (${signal ?? code}).`);
    });
  }

  function closeHelper() {
    clearRetry();
    if (!running) return undefined;
    running.stopping = true;
    return running.probe.stop();
  }

  function configure(next) {
    if (disposed) return;
    const { enabled, quantum } = next;
    if (enabled === options.enabled && quantum === options.quantum) return;
    const toggled = enabled !== options.enabled;
    options = { enabled, quantum };
    if (toggled) {
      failures = 0;
      error = null;
    }
    if (!enabled || !executable || suspended) {
      fallback(!enabled ? "disabled" : executable ? "stale" : "unavailable");
      closeHelper();
    } else {
      if (anchor.quantum !== quantum) fallback("starting");
      if (!running?.stopping) running?.probe.setQuantum(quantum);
      reconcile();
    }
  }

  function snapshot() {
    const mainUs = now();
    if (sample && mainUs - sample.receivedUs > LINK_STALE_US) fallback("stale");
    return {
      version: 1,
      mainUs,
      clockEpoch,
      anchor,
      state,
      enabled: options.enabled,
      available: Boolean(executable),
      peers: sample?.peers ?? 0,
    };
  }

  function diagnostics() {
    const view = snapshot();
    return {
      ...view,
      phase: projectLink(view.anchor, view.mainUs).phase,
      error,
      helper: running && !running.stopping ? (sample ? "running" : "waiting") : "stopped",
      lastSampleAgeMs: sample ? (view.mainUs - sample.receivedUs) / 1000 : null,
      roundTripMs: sample ? sample.rttUs / 1000 : null,
      tempoRevision: sample?.tempoRevision ?? null,
    };
  }

  function setSuspended(value) {
    suspended = value;
    clockEpoch++;
    if (value) {
      if (options.enabled && executable) fallback("stale");
      closeHelper();
    } else {
      reconcile();
    }
  }

  function stop() {
    disposed = true;
    return closeHelper();
  }

  return { configure, snapshot, diagnostics, setSuspended, stop };
}

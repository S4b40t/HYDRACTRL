import {
  LINK_STALE_US,
  createLinkTimeline,
  linkBeatPeriod,
  projectLink,
  wrapBeat,
} from "../../../desktop/src/shared/linkClock.js";

/** Maps main's monotonic microseconds to the current renderer's local origin. */
export function createLinkReader({ now = () => performance.now() * 1000, wall = Date.now } = {}) {
  const fallback = createLinkTimeline(now());
  let packet = null;
  let receivedUs = 0;
  let receivedWallMs = 0;
  let offsetUs = 0;
  let measurements = [];
  let lastBeat = 0;

  function update(next, sentUs, endedUs) {
    const rtt = endedUs - sentUs;
    if (next?.version !== 1 || rtt < 0 || rtt > LINK_STALE_US) return false;
    if (
      !packet ||
      next.clockEpoch !== packet.clockEpoch ||
      endedUs - receivedUs > LINK_STALE_US ||
      wall() - receivedWallMs > LINK_STALE_US / 1000
    ) {
      measurements = [];
    }
    measurements.push({ rtt, offset: sentUs + rtt / 2 - next.mainUs });
    if (measurements.length > 8) measurements.shift();
    offsetUs = measurements.reduce((a, b) => (a.rtt <= b.rtt ? a : b)).offset;
    receivedUs = endedUs;
    receivedWallMs = wall();
    packet = next;
    return true;
  }

  function read() {
    const localUs = now();
    const anchor = packet?.anchor ?? fallback;
    const atUs = packet ? localUs - offsetUs : localUs;
    const loc = projectLink(anchor, atUs);
    lastBeat = Math.max(lastBeat, loc.beat);
    const stale =
      packet?.enabled &&
      (localUs - receivedUs > LINK_STALE_US || wall() - receivedWallMs > LINK_STALE_US / 1000);
    const status = stale ? "stale" : (packet?.state ?? "disabled");
    return {
      ...loc,
      beat: lastBeat,
      bpm: anchor.bpm,
      quantum: anchor.quantum,
      peers: stale ? 0 : (packet?.peers ?? 0),
      status,
      synced: status === "synced",
      epoch: anchor.epoch,
      atUs: localUs,
    };
  }

  return { read, update };
}

/** One trigger cursor per visual effect. Never replay missed or regridded beats. */
export function createLinkBeatTrigger(read) {
  let epoch = null;
  let highest = Number.NEGATIVE_INFINITY;
  let lastTriggerUs = Number.NEGATIVE_INFINITY;
  let previousPeriod = Number.POSITIVE_INFINITY;
  let blockedThroughUs = Number.NEGATIVE_INFINITY;
  return () => {
    const view = read();
    const index = Math.floor(view.grid);
    if (!view.synced || view.epoch !== epoch) {
      epoch = view.synced ? view.epoch : null;
      highest = Math.max(highest, index);
      blockedThroughUs = lastTriggerUs + Math.min(previousPeriod, linkBeatPeriod(view.bpm)) / 2;
      return null;
    }
    if (index <= highest) return null;
    highest = index;
    if (view.atUs <= blockedThroughUs) return null;
    lastTriggerUs = view.atUs;
    previousPeriod = linkBeatPeriod(view.bpm);
    return { downbeat: wrapBeat(index, view.quantum) === 0 };
  };
}

/** Expose one opt-in namespace, without injecting variables into a sketch. */
export function installLinkClient(target, bridge = target.hydractrlLinkTiming) {
  if (!bridge || "hydractrlLink" in target) return null;
  const now = () => performance.now() * 1000;
  const reader = createLinkReader({ now });
  const { read } = reader;
  let timer;
  let disposed = false;
  const api = Object.freeze({
    read() {
      const { beat, phase, normalizedPhase, bpm, quantum, peers, status, synced } = read();
      return { beat, phase, normalizedPhase, bpm, quantum, peers, status, synced };
    },
    /** Beat-synchronous envelope from 1 to 0 over width beats. */
    pulse(width = 0.25) {
      const span = Number.isFinite(width) && width > 0 ? Math.min(1, width) : 0.25;
      return Math.max(0, 1 - wrapBeat(read().grid, 1) / span);
    },
    /** Sine wave in [0, 1]. The default period is the configured quantum. */
    wave(period) {
      const view = read();
      const length = Number.isFinite(period) && period > 0 ? period : view.quantum;
      return 0.5 - 0.5 * Math.cos((2 * Math.PI * wrapBeat(view.grid, length)) / length);
    },
    createBeatTrigger: () => createLinkBeatTrigger(read),
  });
  Object.defineProperty(target, "hydractrlLink", { value: api, configurable: true });

  async function poll() {
    const sentUs = now();
    let packet;
    try {
      packet = await bridge.snapshot();
      if (!disposed) reader.update(packet, sentUs, now());
    } catch (_error) {
      // IPC may temporarily fail while a renderer is being replaced.
    }
    if (!disposed) timer = setTimeout(poll, packet?.enabled ? 100 : 350);
  }
  poll();

  return {
    api,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      if (target.hydractrlLink === api) Reflect.deleteProperty(target, "hydractrlLink");
    },
  };
}

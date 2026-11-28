/**
 * Which audio input a.fft listens to.
 *
 * hydra asks for the system's default microphone the moment an instance is
 * created and offers no way to pick another. `attach` creates the instance
 * and answers that one request itself, with the chosen input, and `choose`
 * moves every instance to another input while it runs: the analyser keeps
 * its settings (bins, cutoff, smoothing) and only its source changes.
 *
 * A choice is `{ deviceId, label }`, or null for the system default. Device
 * ids are the browser's own and change (another browser, cleared site data),
 * so an input is found again by its label. An input that isn't connected
 * leaves a.fft on the system default until it is back.
 */

import { installSpectralAudio } from "./spectralAudio.js";

export const AUDIO_INPUT_KEY = "hydractrl-audio-input";

// Not inputs of their own: the system default and (on Windows) the one for calls
const ALIASES = new Set(["default", "communications"]);

/** A choice as `{ deviceId, label }`, or null for the system default. */
export function normalizeAudioInput(value) {
  if (!value || typeof value !== "object") return null;
  const deviceId = typeof value.deviceId === "string" ? value.deviceId : "";
  const label = typeof value.label === "string" ? value.label : "";
  if (ALIASES.has(deviceId) || (!deviceId && !label)) return null;
  return { deviceId, label };
}

export function sameAudioInput(a, b) {
  if (!a || !b) return !a && !b;
  return a.deviceId === b.deviceId && a.label === b.label;
}

/**
 * The inputs to choose from, `{ inputs: [{ deviceId, label }], defaultLabel }`.
 * Labels are empty until the page may use the microphone. `defaultLabel` is
 * what the browser calls the system default, where it says ("" elsewhere).
 */
export async function listAudioInputs(mediaDevices) {
  const inputs = [];
  let defaultLabel = "";
  if (typeof mediaDevices?.enumerateDevices !== "function") return { inputs, defaultLabel };
  for (const device of await mediaDevices.enumerateDevices()) {
    if (device.kind !== "audioinput") continue;
    if (device.deviceId === "default") defaultLabel = device.label || "";
    if (!device.deviceId || ALIASES.has(device.deviceId)) continue;
    inputs.push({ deviceId: device.deviceId, label: device.label || "" });
  }
  return { inputs, defaultLabel };
}

/** The input a choice means among those connected: the same id, else the same label. */
export function findAudioInput(choice, inputs) {
  if (!choice) return null;
  return (
    inputs.find((input) => input.deviceId === choice.deviceId) ||
    (choice.label ? inputs.find((input) => input.label === choice.label) : null) ||
    null
  );
}

function stopStream(stream) {
  for (const track of stream?.getTracks?.() ?? []) track.stop();
}

function isLive(stream) {
  return Boolean(stream?.getAudioTracks?.().some((track) => track.readyState === "live"));
}

/** hydra's own request, for the default microphone: `{ video: false, audio: true }`. */
function isMicrophoneRequest(constraints) {
  return Boolean(constraints?.audio) && !constraints.video;
}

// Voice processing can remove bass or flatten amplitude before either FFT sees it.
const AUDIO_CAPTURE = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

/**
 * One hydra instance's analyser and the input it listens to.
 * `report` is called whenever that changes.
 */
function createListener(mediaDevices, report) {
  let audio = null;
  let spectral = null;
  let stream = null;
  let unwatch = () => {};
  // The input in use, null for the system default
  let device = null;
  // The choice the stream was opened for, and whether it had to do without it
  let openedFor = null;
  let missing = false;
  let error = null;
  let wanted = null;
  // Gives hydra the stream it asked for, until it has one
  let handOver = null;
  let queue = Promise.resolve();
  let released = false;

  const state = () => ({
    choice: wanted,
    device,
    missing,
    listening: isLive(stream),
    error,
  });

  async function openExact(deviceId) {
    try {
      return await mediaDevices.getUserMedia({
        audio: { ...AUDIO_CAPTURE, deviceId: { exact: deviceId } },
      });
    } catch (_error) {
      return null;
    }
  }

  /** The connected input with the choice's label under another id, and whether labels show. */
  async function lookUp(choice) {
    let inputs = [];
    try {
      ({ inputs } = await listAudioInputs(mediaDevices));
    } catch (_error) {
      // no list: the system default it is
    }
    const match = choice.label
      ? inputs.find(
          (input) => input.label === choice.label && input.deviceId !== choice.deviceId,
        ) || null
      : null;
    return { match, labelled: inputs.some((input) => input.label) };
  }

  /** A stream of the chosen input, or of the system default when it isn't connected. */
  async function open(choice) {
    let labelled = true;
    if (choice) {
      const direct = choice.deviceId ? await openExact(choice.deviceId) : null;
      if (direct) return { stream: direct, device: choice, missing: false };
      const found = await lookUp(choice);
      labelled = found.labelled;
      const byLabel = found.match ? await openExact(found.match.deviceId) : null;
      if (byLabel) return { stream: byLabel, device: found.match, missing: false };
    }
    const fallback = await mediaDevices.getUserMedia({ video: false, audio: AUDIO_CAPTURE });
    if (choice && !labelled) {
      // Labels only show once the page may listen, which it now does
      const { match } = await lookUp(choice);
      const byLabel = match ? await openExact(match.deviceId) : null;
      if (byLabel) {
        stopStream(fallback);
        return { stream: byLabel, device: match, missing: false };
      }
    }
    return { stream: fallback, device: null, missing: Boolean(choice) };
  }

  function watch(opened) {
    const tracks = opened.getAudioTracks?.() ?? [];
    const onEnded = () => {
      if (opened !== stream || released) return;
      if (!isLive(opened)) spectral?.setSource(null);
      missing = Boolean(wanted);
      report();
      use(wanted);
    };
    for (const track of tracks) track.addEventListener?.("ended", onEnded);
    return () => {
      for (const track of tracks) track.removeEventListener?.("ended", onEnded);
    };
  }

  async function apply() {
    // hydra never asked for a microphone here, or its analyser didn't start
    if (released || (!handOver && !audio?.meyda)) return state();
    const choice = wanted;
    if (isLive(stream) && !missing && sameAudioInput(choice, openedFor)) return state();

    let opened;
    try {
      opened = await open(choice);
    } catch (failure) {
      // Nothing to listen to, or not allowed: keep what there is
      error = failure?.message || String(failure);
      report();
      return state();
    }
    if (released) {
      stopStream(opened.stream);
      return state();
    }

    if (!handOver) {
      try {
        const source = audio.context.createMediaStreamSource(opened.stream);
        audio.meyda.setSource(source);
        audio.source = source;
        audio.stream = opened.stream;
      } catch (failure) {
        stopStream(opened.stream);
        error = failure?.message || String(failure);
        report();
        return state();
      }
    }

    const previous = stream;
    unwatch();
    stream = opened.stream;
    device = opened.device;
    missing = opened.missing;
    openedFor = choice;
    error = null;
    if (handOver) {
      // hydra builds its analyser on this stream
      handOver(stream);
      handOver = null;
      await Promise.resolve(); // Hydra's getUserMedia reaction exposes the source.
      if (released) return state();
    }
    spectral?.setSource(isLive(stream) ? audio?.source : null);
    stopStream(previous);
    unwatch = watch(stream);
    report();
    return state();
  }

  /** Listen to a choice. Resolves to the state once it does, or can't. */
  function use(choice) {
    wanted = choice;
    const done = queue.then(apply);
    queue = done.catch(() => {});
    return done;
  }

  /**
   * Create a hydra instance (`create()` returns it) and answer its request
   * for the default microphone with the chosen input.
   */
  function attach(create, choice) {
    wanted = choice;
    if (typeof mediaDevices?.getUserMedia !== "function") {
      const hydra = create();
      audio = hydra?.synth?.a ?? null;
      spectral = installSpectralAudio(audio);
      return hydra;
    }
    const original = mediaDevices.getUserMedia;
    const own = Object.hasOwn(mediaDevices, "getUserMedia");
    let asked = false;
    mediaDevices.getUserMedia = (constraints) => {
      if (asked || !isMicrophoneRequest(constraints)) {
        return original.call(mediaDevices, constraints);
      }
      asked = true;
      return new Promise((resolve) => {
        handOver = resolve;
      });
    };
    let hydra;
    try {
      hydra = create();
    } finally {
      if (own) mediaDevices.getUserMedia = original;
      else Reflect.deleteProperty(mediaDevices, "getUserMedia");
    }
    audio = hydra?.synth?.a ?? null;
    spectral = installSpectralAudio(audio);
    if (asked) use(choice);
    return hydra;
  }

  function release() {
    released = true;
    unwatch();
    spectral?.dispose();
    stopStream(stream);
    stream = null;
    audio?.canvas?.remove();
    if (audio?.context?.state !== "closed") audio?.context?.close?.().catch(() => {});
  }

  return { attach, use, release, state, needsInput: () => missing || !isLive(stream) };
}

/**
 * The audio input of every hydra instance on a page.
 *
 * @param {object} [options]
 * @param {MediaDevices} [options.mediaDevices]
 * @param {object} [options.storage] - Keeps the choice (`getJSON`/`setJSON`).
 * @param {(state: object) => void} [options.onChange] - Called with
 *   `getState()` when the choice, the input in use or the inputs connected change.
 */
export function createAudioInputs(options = {}) {
  const mediaDevices =
    options.mediaDevices !== undefined ? options.mediaDevices : globalThis.navigator?.mediaDevices;
  const { storage, onChange = () => {} } = options;
  let choice = normalizeAudioInput(storage?.getJSON?.(AUDIO_INPUT_KEY));
  // One for each hydra instance; the first is the page's main instance
  const listeners = [];

  function getState() {
    const [main] = listeners;
    return main
      ? { ...main.listener.state(), choice }
      : { choice, device: null, missing: false, listening: false, error: null };
  }

  const announce = () => onChange(getState());

  /** Create a hydra instance with `create()`; its a.fft listens to the chosen input. */
  function attach(create) {
    const listener = createListener(mediaDevices, announce);
    const hydra = listener.attach(create, choice);
    listeners.push({ hydra, listener });
    return hydra;
  }

  function detach(hydra) {
    const index = listeners.findIndex((entry) => entry.hydra === hydra);
    if (index < 0) return;
    const [{ listener }] = listeners.splice(index, 1);
    listener.release();
  }

  /** Listen to an input, `{ deviceId, label }`, or to the system default (null). */
  async function choose(next) {
    choice = normalizeAudioInput(next);
    storage?.setJSON?.(AUDIO_INPUT_KEY, choice);
    announce();
    await Promise.all(listeners.map(({ listener }) => listener.use(choice)));
    return getState();
  }

  /** An input was plugged in or pulled out: go back to the chosen one if it had gone. */
  function refresh() {
    for (const { listener } of listeners) {
      if (listener.needsInput()) listener.use(choice);
    }
    announce();
  }

  mediaDevices?.addEventListener?.("devicechange", refresh);

  return {
    attach,
    detach,
    choose,
    refresh,
    getChoice: () => choice,
    getState,
    list: () => listAudioInputs(mediaDevices),
    dispose() {
      mediaDevices?.removeEventListener?.("devicechange", refresh);
      for (const { listener } of listeners) listener.release();
      listeners.length = 0;
    },
  };
}

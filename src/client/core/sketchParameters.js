export const MAX_PARAMETERS = 64;
export const MAX_PARAMETER_NAME = 80;
export const MAX_ARTICULATION_MS = 60_000;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const MIDI_EASINGS = Object.freeze({
  linear: { label: "Linear", apply: (t) => t },
  smoothstep: { label: "Smoothstep", apply: (t) => t * t * (3 - 2 * t) },
  smootherstep: { label: "Smootherstep", apply: (t) => t ** 3 * (t * (6 * t - 15) + 10) },
  easeIn: { label: "Ease in", apply: (t) => t ** 2 },
  easeOut: { label: "Ease out", apply: (t) => 1 - (1 - t) ** 2 },
});

const durationKeys = ["attack", "release"];
const easingKeys = ["attackEase", "releaseEase"];
const validDuration = (value) =>
  Number.isFinite(value) && value >= 0 && value <= MAX_ARTICULATION_MS;

/** Only JSON-safe overrides travel with a binding or over the output socket. */
export function normalizeArticulation(input) {
  const articulation = {};
  for (const key of durationKeys) {
    if (validDuration(input?.[key])) articulation[key] = input[key];
  }
  for (const key of easingKeys) {
    if (typeof input?.[key] === "string" && Object.hasOwn(MIDI_EASINGS, input[key])) {
      articulation[key] = input[key];
    }
  }
  return Object.keys(articulation).length ? articulation : undefined;
}

export function normalizeParameter(definition) {
  if (!definition || typeof definition !== "object") return null;
  const {
    name,
    min,
    max,
    default: initial,
    attack = 0,
    release = 0,
    curve = 1,
    takeover = true,
  } = definition;
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > MAX_PARAMETER_NAME ||
    ![min, max, initial, curve].every(Number.isFinite) ||
    min >= max ||
    !Number.isFinite(max - min) ||
    initial < min ||
    initial > max ||
    !validDuration(attack) ||
    !validDuration(release) ||
    curve < 0.1 ||
    curve > 10 ||
    typeof takeover !== "boolean"
  )
    return null;
  return { name, min, max, default: initial, attack, release, curve, takeover };
}

export function scaleParameter(definition, cc) {
  if (cc === 127) return definition.max;
  return definition.min + (definition.max - definition.min) * (cc / 127) ** definition.curve;
}

/** One pickup state per binding. Crossing arms the control at the current value. */
export function createParameterPickup(definition, getValue) {
  const { min, max, curve, takeover } = definition;
  let previous;
  let armed = !takeover;
  let anchor = null;
  return (cc) => {
    if (cc === previous) return undefined;
    if (!armed) {
      const value = getValue();
      const target = 127 * ((value - min) / (max - min)) ** (1 / curve);
      const near = Math.abs(cc - target) <= 1;
      const crossed = previous !== undefined && (previous - target) * (cc - target) < 0;
      armed = near || crossed;
      // A coarse step can cross far past the target. Anchor at the displayed
      // value and use the remaining travel on either side to reach the bounds.
      if (!near && crossed) anchor = { input: scaleParameter(definition, cc), value };
      previous = cc;
      return undefined;
    }

    previous = cc;
    const input = scaleParameter(definition, cc);
    if (!anchor) return input;
    if (input === anchor.input) return anchor.value;
    if (cc === 0 || cc === 127) {
      anchor = null;
      return input;
    }
    if (input > anchor.input) {
      return anchor.value + ((input - anchor.input) / (max - anchor.input)) * (max - anchor.value);
    }
    return anchor.value - ((anchor.input - input) / (anchor.input - min)) * (anchor.value - min);
  };
}

/** A renderer owns one registry per execution; Hydra reads getters every frame. */
export function createSketchParameters(now = () => performance.now()) {
  const parameters = new Map();
  let registering = true;

  function register(name, options) {
    if (!registering)
      throw new Error("Register MIDI parameters while the sketch is running its setup.");
    const definitionOptions = { ...options, name };
    const definition = normalizeParameter(definitionOptions);
    if (!definition) throw new Error(`Invalid MIDI parameter definition for "${name}".`);
    for (const key of easingKeys) {
      const easing = definitionOptions[key];
      if (easing !== undefined && typeof easing !== "function")
        throw new Error(`Invalid MIDI parameter ${key} for "${name}": expected a function.`);
    }
    if (parameters.has(name)) throw new Error(`Duplicate MIDI parameter "${name}".`);
    if (parameters.size >= MAX_PARAMETERS)
      throw new Error(`A sketch can register ${MAX_PARAMETERS} MIDI parameters.`);
    let from = definition.default;
    let target = from;
    let started = now();
    let duration = 0;
    let easing;
    let overrides;
    const { min, max } = definition;
    const interpolate = (distance, progress) => clamp(from + distance * progress, min, max);
    const evaluate = (time) => {
      if (!duration || from === target) return target;
      const progress = (time - started) / duration;
      if (progress <= 0) return from;
      if (progress >= 1) return target;
      const distance = target - from;
      if (!easing) return interpolate(distance, progress);

      // The callback stays in this renderer's closure. A bad sample falls
      // back to linear progress without logging from the render loop.
      try {
        const eased = easing(progress);
        if (Number.isFinite(eased)) return interpolate(distance, eased);
        if (eased instanceof Promise) eased.catch(() => {});
      } catch {
        // Keep the transition running if a callback throws.
      }
      return interpolate(distance, progress);
    };
    const get = () => evaluate(now());
    parameters.set(name, {
      definition,
      get,
      snapshot: () => (overrides ? [name, target, overrides] : [name, target]),
      set(value, immediate, articulation) {
        overrides = articulation;
        const next = clamp(value, min, max);
        if (next === target && !immediate) return;
        const time = now();
        from = immediate ? next : evaluate(time);
        const increasing = next > from;
        const durationKey = increasing ? "attack" : "release";
        const easingKey = increasing ? "attackEase" : "releaseEase";
        duration = overrides?.[durationKey] ?? definition[durationKey];
        easing = overrides?.[easingKey]
          ? MIDI_EASINGS[overrides[easingKey]].apply
          : definitionOptions[easingKey];
        target = next;
        started = time;
      },
    });
    return get;
  }

  return {
    register,
    seal: () => {
      registering = false;
    },
    definitions: () => [...parameters.values()].map(({ definition }) => definition),
    values: () => [...parameters.values()].map((param) => param.snapshot()),
    apply(values, immediate = false) {
      for (const [name, value, articulation] of values) {
        if (Number.isFinite(value)) {
          parameters.get(name)?.set(value, immediate, normalizeArticulation(articulation));
        }
      }
    },
  };
}

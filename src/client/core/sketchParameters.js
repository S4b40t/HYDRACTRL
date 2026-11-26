export const MAX_PARAMETERS = 64;
export const MAX_PARAMETER_NAME = 80;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function normalizeParameter(definition) {
  if (!definition || typeof definition !== "object") return null;
  const {
    name,
    min,
    max,
    default: initial,
    smoothing = 0,
    curve = 1,
    takeover = true,
  } = definition;
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > MAX_PARAMETER_NAME ||
    ![min, max, initial, smoothing, curve].every(Number.isFinite) ||
    min >= max ||
    !Number.isFinite(max - min) ||
    initial < min ||
    initial > max ||
    smoothing < 0 ||
    smoothing > 60_000 ||
    curve < 0.1 ||
    curve > 10 ||
    typeof takeover !== "boolean"
  )
    return null;
  return { name, min, max, default: initial, smoothing, curve, takeover };
}

export function scaleParameter(definition, cc) {
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
    const { easing } = definitionOptions;
    const definition = normalizeParameter(definitionOptions);
    if (!definition) throw new Error(`Invalid MIDI parameter definition for "${name}".`);
    if (easing !== undefined && typeof easing !== "function")
      throw new Error(`Invalid MIDI parameter easing for "${name}": expected a function.`);
    if (parameters.has(name)) throw new Error(`Duplicate MIDI parameter "${name}".`);
    if (parameters.size >= MAX_PARAMETERS)
      throw new Error(`A sketch can register ${MAX_PARAMETERS} MIDI parameters.`);
    let from = definition.default;
    let target = from;
    let started = now();
    const { min, max, smoothing } = definition;
    const evaluate = (time) => {
      const progress = (time - started) / smoothing;
      if (progress <= 0) return from;
      if (progress >= 1) return target;
      const distance = target - from;
      if (!easing) return from + distance * progress;

      // The callback stays in this renderer's closure. A bad sample falls
      // back to linear progress without logging from the render loop.
      try {
        const eased = easing(progress);
        if (Number.isFinite(eased)) return clamp(from + distance * eased, min, max);
        if (eased instanceof Promise) eased.catch(() => {});
      } catch {
        // Keep the transition running if a callback throws.
      }
      return from + distance * progress;
    };
    const get = () => (smoothing && from !== target ? evaluate(now()) : target);
    parameters.set(name, {
      definition,
      get,
      getTarget: () => target,
      set(value, immediate) {
        const next = clamp(value, min, max);
        if (next === target && !immediate) return;
        const time = now();
        if (immediate || !smoothing) from = next;
        else if (from !== target) from = evaluate(time);
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
    values: () => [...parameters].map(([name, param]) => [name, param.getTarget()]),
    apply(values, immediate = false) {
      for (const [name, value] of values) {
        if (Number.isFinite(value)) parameters.get(name)?.set(value, immediate);
      }
    },
  };
}

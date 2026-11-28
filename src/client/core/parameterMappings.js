import { controlKey, normalizeControl } from "./midiControls.js";
import {
  MAX_PARAMETERS,
  MAX_PARAMETER_NAME,
  createParameterPickup,
  normalizeArticulation,
  normalizeParameter,
} from "./sketchParameters.js";

function normalizeBinding(candidate) {
  const control = normalizeControl(candidate, true);
  if (!control) return null;
  const articulation = normalizeArticulation(candidate.articulation);
  return articulation ? { ...control, articulation } : control;
}

export function normalizeParameterMappings(input) {
  const mappings = new Map();
  const controls = new Set();
  if (!Array.isArray(input)) return mappings;
  for (const entry of input.slice(0, MAX_PARAMETERS)) {
    if (!Array.isArray(entry)) continue;
    const [name, candidate] = entry;
    const binding = normalizeBinding(candidate);
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > MAX_PARAMETER_NAME ||
      !binding ||
      mappings.has(name) ||
      controls.has(controlKey(binding))
    )
      continue;
    controls.add(controlKey(binding));
    mappings.set(name, binding);
  }
  return mappings;
}

export function createParameterMappings({ read, write, onChange }) {
  let active = null;
  let mappings = new Map();
  const pickups = new Map();

  function activate(run, slot, definitions) {
    const parameters = new Map();
    for (const candidate of definitions ?? []) {
      const definition = normalizeParameter(candidate);
      if (definition) parameters.set(definition.name, definition);
    }
    active = {
      run,
      slot,
      parameters,
      values: new Map([...parameters].map(([name, definition]) => [name, definition.default])),
    };
    mappings = slot ? read(slot) : new Map();
    pickups.clear();
  }

  function assign(name, candidate) {
    if (!active?.slot || !active.parameters.has(name))
      return "Save and run this sketch in a slot first.";
    const previous = mappings.get(name);
    const binding =
      candidate && normalizeBinding({ ...candidate, articulation: previous?.articulation });
    if (candidate && !binding) return "Use a MIDI CC for a sketch parameter.";
    const next = new Map(mappings);
    if (binding) {
      for (const [other, assigned] of mappings) {
        if (other === name || controlKey(assigned) !== controlKey(binding)) continue;
        if (active.parameters.has(other)) return `Already assigned to ${other} in this sketch.`;
        next.delete(other);
      }
      next.set(name, binding);
    } else {
      next.delete(name);
    }
    if (!write(active.slot, next)) return "Could not save the sketch mapping.";
    mappings = next;
    pickups.delete(name);
    if (!binding && previous?.articulation) onChange(snapshot());
    return null;
  }

  function configure(name, articulation) {
    const binding = mappings.get(name);
    if (!binding || !active?.slot || !active.parameters.has(name))
      return "Learn a CC before editing articulation.";
    const next = new Map(mappings);
    next.set(name, normalizeBinding({ ...binding, articulation }));
    if (!write(active.slot, next)) return "Could not save articulation.";
    mappings = next;
    onChange(snapshot());
    return null;
  }

  function snapshot() {
    return active?.parameters.size
      ? {
          parameterRun: active.run,
          values: [...active.values].map(([name, value]) => {
            const articulation = mappings.get(name)?.articulation;
            return articulation ? [name, value, articulation] : [name, value];
          }),
        }
      : null;
  }

  function resetValues(directOnly = false) {
    pickups.clear();
    if (!active) return;
    let changed = false;
    for (const [name, definition] of active.parameters) {
      if (directOnly && definition.takeover) continue;
      if (active.values.get(name) !== definition.default) {
        active.values.set(name, definition.default);
        changed = true;
      }
    }
    if (changed) onChange(snapshot());
  }

  function dispatch(control) {
    if (control.type !== "cc") return false;
    const key = controlKey(control);
    for (const [name, binding] of mappings) {
      if (controlKey(binding) !== key) continue;
      const definition = active.parameters.get(name);
      if (!definition) continue;
      if (!pickups.has(name)) {
        pickups.set(
          name,
          createParameterPickup(definition, () => active.values.get(name)),
        );
      }
      const value = pickups.get(name)(control.value);
      if (value !== undefined && value !== active.values.get(name)) {
        active.values.set(name, value);
        onChange(snapshot());
      }
      return true;
    }
    return false;
  }

  return {
    activate,
    assign,
    configure,
    dispatch,
    snapshot,
    getSlot: () => active?.slot,
    isMapped: (binding) =>
      [...mappings].some(
        ([name, assigned]) =>
          active?.parameters.has(name) && controlKey(assigned) === controlKey(binding),
      ),
    rows: () =>
      [...(active?.parameters.values() ?? [])].map((definition) => ({
        name: definition.name,
        definition,
        binding: mappings.get(definition.name),
      })),
    resetPickup: () => pickups.clear(),
    resetValues,
  };
}

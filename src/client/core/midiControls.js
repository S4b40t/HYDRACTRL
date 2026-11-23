export const NAVIGATION_ACTIONS = {
  slot: "Pending slot",
  confirm: "Confirm pending slot",
  previous: "Previous pending bank",
  next: "Next pending bank",
  bank: "Pending bank (selector)",
};

export function quantizeMidi(value, count) {
  return Math.floor((value * count) / 128);
}

export function readMidiControl(data) {
  if (data?.length !== 3) return null;
  const [status, number, value] = data;
  if (![number, value].every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 127)) {
    return null;
  }
  const channel = status & 0x0f;
  switch (status & 0xf0) {
    case 0xb0:
      return { type: "cc", channel, number, value };
    case 0x90:
      return { type: "note", channel, number, value };
    case 0x80:
      return { type: "note", channel, number, value: 0 };
    default:
      return null;
  }
}

export function controlKey({ type, channel, number }) {
  return `${type}:${channel}:${number}`;
}

export function isContinuousAction(action) {
  return action === "slot" || action === "bank";
}

export function normalizeControl(control, continuous = false) {
  if (!control || (control.type !== "cc" && (continuous || control.type !== "note"))) {
    return null;
  }
  const { type, channel, number } = control;
  if (
    !Number.isInteger(channel) ||
    channel < 0 ||
    channel > 15 ||
    !Number.isInteger(number) ||
    number < 0 ||
    number > 127
  )
    return null;
  const binding = { type, channel, number };
  if (!continuous && type === "cc" && control.mode === "toggle") binding.mode = "toggle";
  return binding;
}

export function normalizeNavigationProfile(profile) {
  const bindings = {};
  const used = new Set();
  for (const action of Object.keys(NAVIGATION_ACTIONS)) {
    const binding = normalizeControl(profile?.[action], isContinuousAction(action));
    if (!binding || used.has(controlKey(binding))) continue;
    used.add(controlKey(binding));
    bindings[action] = binding;
  }
  return bindings;
}

export function createNavigationControls(slots) {
  const buttonStates = new Map();

  function buttonPressed(binding, control) {
    if (binding.mode === "toggle") {
      if (control.value !== 0 && control.value !== 127) return false;
      const key = controlKey(control);
      const previous = buttonStates.get(key);
      buttonStates.set(key, control.value);
      return previous !== control.value;
    }
    const key = controlKey(control);
    const down = control.value >= (control.type === "note" ? 1 : 64);
    const previous = buttonStates.get(key);
    buttonStates.set(key, down);
    return down && !previous;
  }

  function dispatch(action, binding, control) {
    if (action === "slot") slots.setPendingSlot(quantizeMidi(control.value, 16));
    else if (action === "bank") slots.setPendingBank(quantizeMidi(control.value, 4));
    else if (buttonPressed(binding, control)) {
      if (action === "confirm") slots.confirmPendingSlot();
      else slots.cyclePendingBank(action === "previous" ? -1 : 1);
    }
  }

  return { dispatch, buttonPressed, reset: () => buttonStates.clear() };
}

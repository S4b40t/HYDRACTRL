const midi = {
  description: "Register a sketch parameter and return its live getter.",
  params: [
    { name: "name", documentation: "The name used to learn or restore the MIDI mapping." },
    {
      name: "options",
      documentation:
        "Specify min, max and default. Optional: attack and release (ms), attackEase and releaseEase (synchronous functions), curve, and takeover.",
    },
  ],
};

const audio = {
  setBandRanges: {
    description: "Use custom frequency bands for a.fft.",
    params: [
      { name: "ranges", documentation: "Frequency pairs [low, high] in Hz, in a.fft order." },
    ],
  },
  getBandRanges: { description: "Read the current custom frequency bands.", params: [] },
  clearBandRanges: { description: "Return to the legacy FFT bins.", params: [] },
};

const link = {
  read: { description: "Read the current Link beat, phase, tempo and sync status.", params: [] },
  pulse: {
    description: "Return a beat-synchronous envelope from 1 to 0.",
    params: [{ name: "width", default: "0.25", documentation: "Pulse width in beats." }],
  },
  wave: {
    description: "Return a beat-synchronous sine wave from 0 to 1.",
    params: [{ name: "period", documentation: "Period in beats. Defaults to the Link quantum." }],
  },
  createBeatTrigger: {
    description: "Create an independent trigger for new synced beats.",
    params: [],
  },
};

export const portableCompletionNames = [
  "midiParam",
  "hydractrlLink",
  ...Object.keys(audio),
  ...Object.keys(link),
];

export function portableGlobalSignature(name, capabilities) {
  return name === "midiParam" && capabilities?.midi ? midi : null;
}

export function portableMember(state, receiver, name, custom, capabilities) {
  if (!capabilities) return null;
  const text = (node) => state.sliceDoc(node.from, node.to);
  const isGlobalThis = (node) =>
    node?.name === "VariableName" &&
    text(node) === "globalThis" &&
    custom("globalThis", node.from) === undefined;

  if (
    Object.hasOwn(audio, name) &&
    receiver.name === "VariableName" &&
    text(receiver) === "a" &&
    custom("a", receiver.from) === undefined &&
    typeof capabilities.audio?.[name] === "function"
  ) {
    return audio[name];
  }
  if (name === "hydractrlLink" && capabilities.link && isGlobalThis(receiver)) {
    return { description: "The desktop Link timing API." };
  }
  if (
    Object.hasOwn(link, name) &&
    typeof capabilities.link?.[name] === "function" &&
    receiver.name === "MemberExpression" &&
    receiver.lastChild?.name === "PropertyName" &&
    receiver.lastChild.prevSibling?.name === "." &&
    text(receiver.lastChild) === "hydractrlLink" &&
    isGlobalThis(receiver.firstChild)
  ) {
    return link[name];
  }
  return null;
}

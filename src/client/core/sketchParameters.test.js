import { expect, spyOn, test } from "bun:test";
import { createParameterMappings, normalizeParameterMappings } from "./parameterMappings.js";
import { createPrimaryRunner } from "./primaryRunner.js";
import {
  createParameterPickup,
  createSketchParameters,
  normalizeParameter,
  scaleParameter,
} from "./sketchParameters.js";
import { applySketchParameters, executeSketch } from "./sketchRunner.js";

test("Hydra evaluates a live getter without running the sketch again", async () => {
  let runs = 0;
  const hydra = {
    hush() {
      runs++;
    },
    useMidiProbe(getter) {
      this.getter = getter;
    },
  };
  const sketch = {
    main: 'const depth = midiParam("Depth", { default: 0.4, min: 0, max: 1 }); useMidiProbe(depth);',
    parameterRun: "first",
  };
  expect((await executeSketch(hydra, sketch)).parameters).toEqual([
    { name: "Depth", default: 0.4, min: 0, max: 1, curve: 1, smoothing: 0, takeover: true },
  ]);
  expect(hydra.getter()).toBe(0.4);
  expect(applySketchParameters(hydra, { parameterRun: "old", values: [["Depth", 1]] })).toBe(false);
  expect(applySketchParameters(hydra, { parameterRun: "first", values: [["Depth", 0.75]] })).toBe(
    true,
  );
  expect(hydra.getter()).toBe(0.75);
  expect(runs).toBe(1);
  await executeSketch(hydra, { ...sketch, parameterRun: "second" });
  expect(hydra.getter()).toBe(0.4);
  expect(applySketchParameters(hydra, { parameterRun: "first", values: [["Depth", 1]] })).toBe(
    false,
  );
});

test("smoothing starts from the current interpolated value and obeys bounds", () => {
  let time = 0;
  const registry = createSketchParameters(() => time);
  const value = registry.register("Amount", { default: 0, min: 0, max: 10, smoothing: 100 });
  registry.apply([["Amount", 50]]);
  time = 50;
  expect(value()).toBe(5);
  registry.apply([["Amount", 10]]);
  time = 60;
  registry.apply([["Amount", 0]]);
  expect(value()).toBe(6);
  time = 110;
  expect(value()).toBe(3);
  time = 160;
  expect(value()).toBe(0);
});

test("custom easing receives interior progress and preserves exact endpoints both ways", () => {
  let time = 0;
  const samples = [];
  const registry = createSketchParameters(() => time);
  const value = registry.register("Amount", {
    default: 0.1,
    min: 0,
    max: 1,
    smoothing: 100,
    easing: (t) => {
      samples.push(t);
      return 0.1 + 0.8 * t ** 2;
    },
  });
  registry.apply([["Amount", 1]]);
  expect(value()).toBe(0.1);
  time = 50;
  expect(value()).toBeCloseTo(0.37, 12);
  time = 100;
  expect(value()).toBe(1);
  registry.apply([["Amount", 0.1]]);
  expect(value()).toBe(1);
  time = 150;
  expect(value()).toBeCloseTo(0.73, 12);
  time = 200;
  expect(value()).toBe(0.1);
  expect(samples).toEqual([0.5, 0.5]);
});

test("easing can pass the target inside the range but cannot pass either bound", () => {
  let time = 0;
  const registry = createSketchParameters(() => time);
  const value = registry.register("Amount", {
    default: 0,
    min: 0,
    max: 1,
    smoothing: 100,
    easing: (t) => (t < 0.5 ? -Number.MAX_VALUE : 2),
  });
  registry.apply([["Amount", 0.4]]);
  time = 25;
  expect(value()).toBe(0);
  time = 50;
  expect(value()).toBe(0.8);
  time = 100;
  expect(value()).toBe(0.4);
  registry.apply([["Amount", 1]]);
  time = 125;
  expect(value()).toBe(0);
  time = 150;
  expect(value()).toBe(1);
});

test("easing follows rapid reversals, and duplicate targets leave the transition alone", () => {
  let time = 0;
  const registry = createSketchParameters(() => time);
  const value = registry.register("Amount", {
    default: 0,
    min: 0,
    max: 1,
    smoothing: 100,
    easing: (t) => t ** 2,
  });
  registry.apply([["Amount", 1]]);
  time = 50;
  registry.apply([["Amount", 1]]);
  expect(value()).toBe(0.25);
  registry.apply([["Amount", 0]]);
  expect(value()).toBe(0.25);
  time = 75;
  expect(value()).toBe(0.234375);
  registry.apply([["Amount", 0.9]]);
  expect(value()).toBe(0.234375);
  time = 124;
  expect(value()).toBeGreaterThan(0.234375);
  time = 175;
  expect(value()).toBe(0.9);
});

test("zero smoothing and immediate restoration bypass easing", () => {
  let time = 0;
  let calls = 0;
  const registry = createSketchParameters(() => time);
  const options = {
    default: 0,
    min: 0,
    max: 1,
    easing: (t) => {
      calls++;
      return t ** 2;
    },
  };
  const instant = registry.register("Instant", { ...options, smoothing: 0 });
  const eased = registry.register("Eased", { ...options, smoothing: 100 });
  registry.apply([
    ["Instant", 0.8],
    ["Eased", 1],
  ]);
  time = 25;
  expect(instant()).toBe(0.8);
  registry.apply([["Eased", 1]], true);
  expect(eased()).toBe(1);
  expect(calls).toBe(0);
});

test("easing registration rejects invalid option types", () => {
  const registry = createSketchParameters();
  for (const easing of [null, "smoothstep", 2, {}, true]) {
    expect(() =>
      registry.register("Amount", { name: "Amount", default: 0, min: 0, max: 1, easing }),
    ).toThrow('Invalid MIDI parameter easing for "Amount"');
  }
});

test.each([
  [
    "throw",
    () => {
      throw new Error("bad sample");
    },
  ],
  ["NaN", () => Number.NaN],
  ["positive infinity", () => Number.POSITIVE_INFINITY],
  ["negative infinity", () => Number.NEGATIVE_INFINITY],
  ["numeric string", () => "0.75"],
  ["undefined", () => undefined],
  ["object", () => ({ value: 0.75 })],
  [
    "rejected async callback",
    async () => {
      throw new Error("bad async sample");
    },
  ],
])("a %s easing result falls back to linear progress", async (_kind, easing) => {
  let time = 0;
  const registry = createSketchParameters(() => time);
  const value = registry.register("Amount", { default: 0, min: 0, max: 1, smoothing: 100, easing });
  registry.apply([["Amount", 1]]);
  time = 25;
  expect(value()).toBe(0.25);
  await Promise.resolve();
  time = 50;
  expect(value()).toBe(0.5);
});

test("Soft Takeover crosses the displayed eased value without a jump", () => {
  let time = 0;
  const registry = createSketchParameters(() => time);
  const value = registry.register("Amount", {
    default: 0,
    min: 0,
    max: 1,
    smoothing: 100,
    easing: (t) => t ** 2,
  });
  registry.apply([["Amount", 1]]);
  time = 50;
  const pickup = createParameterPickup(registry.definitions()[0], value);
  for (const cc of [0, 80, 80]) expect(pickup(cc)).toBeUndefined();
  const next = pickup(81);
  expect(next).toBeCloseTo(0.25 + 0.75 / 47, 12);
  registry.apply([["Amount", next]]);
  expect(value()).toBe(0.25);
  time = 150;
  expect(value()).toBe(next);
});

test("independent renderers execute Setup easing and exchange serializable definitions and targets", async () => {
  let time = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => time);
  try {
    const sketch = {
      setup: "const easeOut = (progress, power) => 1 - (1 - progress) ** power;",
      main: `midiEasingProbe(midiParam("Amount", {
        default: 0, min: 0, max: 1, smoothing: 100, easing: t => easeOut(t, 3)
      }));`,
      parameterRun: "eased",
    };
    const createRenderer = () => ({
      hush() {},
      midiEasingProbe(getter) {
        this.getter = getter;
      },
    });
    const first = createRenderer();
    const second = createRenderer();
    const definition = {
      name: "Amount",
      default: 0,
      min: 0,
      max: 1,
      smoothing: 100,
      curve: 1,
      takeover: true,
    };
    for (const renderer of [first, second]) {
      const result = await executeSketch(renderer, sketch);
      expect(result.parameters).toEqual([definition]);
      expect(structuredClone(result.parameters)).toEqual([definition]);
    }
    expect(first.getter).not.toBe(second.getter);
    const state = { parameterRun: "eased", values: [["Amount", 1]] };
    applySketchParameters(first, state);
    time = 20;
    expect(second.getter()).toBe(0);
    applySketchParameters(second, structuredClone(state));
    time = 70;
    expect(first.getter()).toBeCloseTo(0.973, 12);
    expect(second.getter()).toBe(0.875);
    time = 120;
    expect(first.getter()).toBe(1);
    expect(second.getter()).toBe(1);
  } finally {
    clock.mockRestore();
  }
});

test("scales a curved response and validates range and options", () => {
  const definition = normalizeParameter({ name: "Size", min: 2, max: 10, default: 5, curve: 2 });
  expect(scaleParameter(definition, 0)).toBe(2);
  expect(scaleParameter(definition, 127)).toBe(10);
  expect(scaleParameter(definition, 64)).toBeCloseTo(4.03);
  expect(normalizeParameter({ ...definition, default: 20 })).toBeNull();
  expect(normalizeParameter({ ...definition, smoothing: -1 })).toBeNull();
});

test("one physical control uses separate sketch mappings and picks up each default", () => {
  const persisted = new Map();
  const changes = [];
  const config = {
    read: (slot) => normalizeParameterMappings(persisted.get(slot)),
    write: (slot, mappings) => {
      persisted.set(slot, [...mappings]);
      return true;
    },
    onChange: (state) => changes.push(state),
  };
  const cc = { type: "cc", channel: 0, number: 12 };
  const manager = createParameterMappings(config);
  const first = { bank: 0, slot: 0 };
  manager.activate("first", first, [
    { name: "Depth", min: 0, max: 1, default: 0.5 },
    { name: "Rate", min: 0, max: 1, default: 0 },
  ]);
  expect(manager.assign("Depth", cc)).toBeNull();
  expect(manager.assign("Rate", cc)).toContain("Already assigned");
  for (const value of [0, 40, 70]) manager.dispatch({ ...cc, value });
  expect(changes).toEqual([]);
  manager.dispatch({ ...cc, value: 70 }); // Duplicate crossing sample still leaves it alone
  expect(changes).toEqual([]);
  manager.dispatch({ ...cc, value: 71 });
  expect(changes.at(-1).parameterRun).toBe("first");
  expect(changes.at(-1).values[0][1]).toBeCloseTo(0.5 + 0.5 / 57, 8);

  const second = { bank: 0, slot: 1 };
  manager.activate("second", second, [{ name: "Feedback", min: 0.5, max: 1, default: 1 }]);
  expect(manager.assign("Feedback", cc)).toBeNull();
  manager.dispatch({ ...cc, value: 30 });
  expect(changes.length).toBe(1);
  manager.dispatch({ ...cc, value: 127 });
  expect(changes.length).toBe(1);
  manager.dispatch({ ...cc, value: 100 });
  expect(changes.at(-1).values).toEqual([["Feedback", 0.5 + 0.5 * (100 / 127)]]);
  const restarted = createParameterMappings(config);
  restarted.activate("restarted", first, [{ name: "Depth", min: 0, max: 1, default: 0.5 }]);
  expect(restarted.rows()).toEqual([{ name: "Depth", binding: cc }]);
});

test("desktop primary reports declarations, skips a repeated broadcast, and restores targets after a failed run", async () => {
  let runs = 0;
  const hydra = {
    hush() {
      runs++;
    },
    midiPrimaryProbe(getter) {
      this.getter = getter;
    },
  };
  const primary = createPrimaryRunner({ hydra });
  const sketch = {
    main: 'midiPrimaryProbe(midiParam("Level", { default: 0, min: 0, max: 1 }))',
    parameterRun: "live",
  };
  expect((await primary.run("remote", sketch)).parameters[0].name).toBe("Level");
  expect((await primary.runSketch(sketch, { runId: "remote" })).skipped).toBe(true);
  applySketchParameters(hydra, { parameterRun: "live", values: [["Level", 0.6]] });
  expect(runs).toBe(1);
  expect(
    (await primary.run("failure", { main: 'throw new Error("failed")', parameterRun: "next" }))
      .success,
  ).toBe(false);
  expect(hydra.getter()).toBe(0.6);
});

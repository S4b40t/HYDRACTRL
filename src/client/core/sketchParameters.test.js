import { expect, test } from "bun:test";
import { createParameterMappings, normalizeParameterMappings } from "./parameterMappings.js";
import { createPrimaryRunner } from "./primaryRunner.js";
import { createSketchParameters, normalizeParameter, scaleParameter } from "./sketchParameters.js";
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

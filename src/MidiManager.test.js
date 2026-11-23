import { describe, expect, test } from "bun:test";
import { sceneForNote } from "./MidiManager.js";
import {
  createNavigationControls,
  normalizeNavigationProfile,
  readMidiControl,
} from "./client/core/midiControls.js";

// Two notes per scene are enough to show the rule
const MAPPING = [
  [
    { note: 37, slot: 0 },
    { note: 36, slot: 8 },
  ],
  [
    { note: 53, slot: 0 },
    { note: 52, slot: 8 },
  ],
  [{ note: 69, slot: 0 }],
  [{ note: 85, slot: 0 }],
];

describe("sceneForNote", () => {
  test("keeps the current scene when it plays the note", () => {
    expect(sceneForNote(MAPPING, 0, 37)).toBe(0);
    expect(sceneForNote(MAPPING, 1, 52)).toBe(1);
  });

  test("finds the scene a pad belongs to when the scene button's message got lost", () => {
    expect(sceneForNote(MAPPING, 0, 53)).toBe(1);
    expect(sceneForNote(MAPPING, 1, 85)).toBe(3);
    expect(sceneForNote(MAPPING, 3, 36)).toBe(0);
  });

  test("prefers the current scene when a learned note is in two scenes", () => {
    const learned = MAPPING.map((scene) => [...scene]);
    learned[2].push({ note: 37, slot: 5 });
    expect(sceneForNote(learned, 2, 37)).toBe(2);
    expect(sceneForNote(learned, 1, 37)).toBe(0);
  });

  test("is -1 for a note no scene plays", () => {
    expect(sceneForNote(MAPPING, 0, 12)).toBe(-1);
  });
});

describe("configurable navigation", () => {
  test("all 128 values cover 16 equal pending-slot ranges without activation", () => {
    const selections = [];
    const nav = createNavigationControls({
      setPendingSlot: (slot) => selections.push(slot),
      confirmPendingSlot: () => {
        throw new Error("Selector must not activate");
      },
    });
    for (let value = 0; value < 128; value++) {
      nav.dispatch("slot", {}, readMidiControl([0xb3, 15, value]));
    }
    expect(selections).toEqual(Array.from({ length: 128 }, (_, value) => Math.floor(value / 8)));
  });

  test("momentary CC and note buttons activate once per press", () => {
    let confirms = 0;
    const nav = createNavigationControls({
      confirmPendingSlot: () => {
        confirms++;
      },
    });
    for (const data of [
      [0xb0, 1, 127],
      [0xb0, 1, 127],
      [0xb0, 1, 0],
      [0xb0, 1, 0],
      [0xb0, 1, 127],
      [0x92, 60, 100],
      [0x92, 60, 50],
      [0x82, 60, 100],
      [0x92, 60, 1],
      [0x92, 60, 0],
    ]) {
      nav.dispatch("confirm", {}, readMidiControl(data));
    }
    expect(confirms).toBe(4);
  });

  test("bank controls browse in both directions or select an exact pending bank", () => {
    const events = [];
    const nav = createNavigationControls({
      setPendingBank: (bank) => events.push(bank),
      cyclePendingBank: (direction) => events.push(direction),
    });
    nav.dispatch("previous", {}, readMidiControl([0x90, 12, 127]));
    nav.dispatch("next", {}, readMidiControl([0xb0, 13, 127]));
    nav.dispatch("bank", {}, readMidiControl([0xb0, 14, 127]));
    expect(events).toEqual([-1, 1, 3]);
  });

  test("persisted profiles reject invalid and conflicting bindings", () => {
    const binding = { type: "cc", channel: 2, number: 88 };
    expect(
      normalizeNavigationProfile({
        slot: binding,
        confirm: binding,
        next: { type: "cc", channel: 20, number: 12 },
        previous: { type: "note", channel: 2, number: 88 },
      }),
    ).toEqual({ slot: binding, previous: { type: "note", channel: 2, number: 88 } });
  });
});

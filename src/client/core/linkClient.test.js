import { expect, test } from "bun:test";
import {
  anchorLink,
  createLinkTimeline,
  projectLink,
} from "../../../desktop/src/shared/linkClock.js";
import { createLinkBeatTrigger, createLinkReader, installLinkClient } from "./linkClient.js";

test("large corrections and quantum changes regrid without jumping the continuous beat", () => {
  const a = createLinkTimeline(0);
  const synced = anchorLink(a, 500000, { phase: 3.2, quantum: 4, bpm: 120, reset: true });
  expect(synced.beat).toBe(1);
  expect(synced.epoch).toBe(1);
  expect(projectLink(synced, 1000000).phase).toBeCloseTo(0.2);
  const changed = anchorLink(synced, 1000000, { phase: 0.25, quantum: 3, bpm: 90 });
  expect(changed.epoch).toBe(2);
  expect(changed.beat).toBe(2);
  expect(projectLink(changed, 1000000).normalizedPhase).toBeCloseTo(0.25 / 3);
});

test("a small phase correction slews under tempo change and stays monotonic", () => {
  const a = createLinkTimeline();
  const changed = anchorLink(a, 500000, { phase: 0.9, quantum: 4, bpm: 20 });
  expect(changed.epoch).toBe(0);
  expect(projectLink(changed, 500000).phase).toBe(1);
  expect(projectLink(changed, 1000000).phase).toBeCloseTo(1 + 1 / 6 - 0.1);
});

test("renderer reloads map a common anchor and stale state clears peers", () => {
  let local = 1000;
  let wall = 0;
  const first = createLinkReader({ now: () => local, wall: () => wall });
  const second = createLinkReader({ now: () => local + 5000, wall: () => wall });
  const anchor = createLinkTimeline(90000);
  const packet = {
    version: 1,
    mainUs: 90000,
    clockEpoch: 0,
    anchor,
    state: "synced",
    enabled: true,
    peers: 1,
  };
  first.update(packet, 900, 1100);
  second.update(packet, 5995, 6005);
  local = 501000;
  expect(first.read()).toMatchObject({ beat: 1, phase: 1, synced: true });
  expect(second.read()).toMatchObject({ beat: 1, phase: 1, synced: true });
  wall = 800;
  expect(first.read()).toMatchObject({ status: "stale", peers: 0, synced: false });
  expect(first.update(packet, 0, 700000)).toBe(false);
  const resumed = { ...packet, mainUs: 590000, clockEpoch: 1 };
  expect(first.update(resumed, local - 10, local + 10)).toBe(true);
  expect(first.read().phase).toBe(1);
});

test("beat triggers suppress repeated beats, jumps, regrid duplicates and missed beats", () => {
  let view = { synced: true, epoch: 0, grid: 3.9, quantum: 4, bpm: 120, atUs: 0 };
  const trigger = createLinkBeatTrigger(() => view);
  expect(trigger()).toBeNull();
  view = { ...view, grid: 4, atUs: 50000 };
  expect(trigger()).toEqual({ downbeat: true });
  expect(trigger()).toBeNull();
  view = { ...view, epoch: 1, grid: 3.8, atUs: 100000 };
  expect(trigger()).toBeNull();
  view = { ...view, grid: 4, atUs: 200000 };
  expect(trigger()).toBeNull();
  view = { ...view, grid: 7, atUs: 1800000 };
  expect(trigger()).toEqual({ downbeat: false });
  expect(trigger()).toBeNull();
  view = { ...view, grid: 8, synced: false };
  expect(trigger()).toBeNull();
});

test("a large backward regrid cannot replay previously crossed beat numbers", () => {
  let view = { synced: true, epoch: 0, grid: 3.9, quantum: 4, bpm: 120, atUs: 0 };
  const trigger = createLinkBeatTrigger(() => view);
  expect(trigger()).toBeNull();
  view = { ...view, grid: 4.01, atUs: 50000 };
  expect(trigger()).toEqual({ downbeat: true });
  view = { ...view, grid: 2.2, epoch: 1, atUs: 100000 };
  expect(trigger()).toBeNull();
  view = { ...view, grid: 4.01, atUs: 1100000 };
  expect(trigger()).toBeNull();
  view = { ...view, grid: 5, atUs: 1600000 };
  expect(trigger()).toEqual({ downbeat: false });
});

test("install leaves a user-defined namespace intact", () => {
  const existing = { hydractrlLink: { ownedBySketch: true } };
  expect(installLinkClient(existing, {})).toBeNull();
  expect(existing.hydractrlLink.ownedBySketch).toBe(true);
});

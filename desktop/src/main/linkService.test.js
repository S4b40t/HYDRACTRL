import { expect, test } from "bun:test";
import { projectLink } from "../shared/linkClock.js";
import { createLinkService } from "./linkService.js";

function harness(executable = "/helper") {
  const workers = [];
  let now = 0;
  let retry;
  const service = createLinkService({
    executable,
    log: {},
    now: () => now,
    timers: {
      setTimeout(fn) {
        retry = fn;
        return 1;
      },
      clearTimeout() {
        retry = null;
      },
    },
    startProbe(options) {
      const { promise: done, resolve } = Promise.withResolvers();
      const worker = {
        options,
        done,
        resolve,
        stopCalls: 0,
        stop() {
          this.stopCalls++;
          return done;
        },
        setQuantum(quantum) {
          this.quantum = quantum;
        },
        emit(peers, phase = 0, quantum = 4, bpm = 120, rtt = 100) {
          options.onSample({
            sample: { bpm, peers, quantum, tempoRevision: 0, hostUs: now },
            receivedUs: now,
            measurement: { roundTripUs: rtt },
            timing: { phase },
          });
        },
      };
      workers.push(worker);
      return worker;
    },
  });
  return {
    service,
    workers,
    at(us) {
      now = us;
    },
    retry() {
      return retry?.();
    },
  };
}

test("disabled, unavailable, and zero peers never report synchronization", () => {
  const unavailable = harness(null);
  unavailable.service.configure({ enabled: true, quantum: 4 });
  expect(unavailable.service.snapshot().state).toBe("unavailable");
  expect(unavailable.workers).toHaveLength(0);

  const { service, workers } = harness();
  expect(service.snapshot().state).toBe("disabled");
  service.configure({ enabled: true, quantum: 4 });
  expect(service.snapshot().state).toBe("starting");
  workers[0].emit(0);
  expect(service.snapshot()).toMatchObject({ state: "local", peers: 0 });
});

test("quantum changes keep the peer and reject an in-flight old quantum", () => {
  const { service, workers, at } = harness();
  service.configure({ enabled: true, quantum: 4 });
  at(1000);
  workers[0].emit(1, 3.5);
  const first = service.snapshot();
  expect(first.state).toBe("synced");
  expect(projectLink(first.anchor, first.mainUs).phase).toBeCloseTo(3.5);
  at(51000);
  service.configure({ enabled: true, quantum: 3 });
  expect(workers[0].quantum).toBe(3);
  workers[0].emit(1, 1, 4);
  expect(service.snapshot().state).toBe("starting");
  workers[0].emit(1, 2, 3, 140);
  expect(workers).toHaveLength(1);
  expect(service.snapshot()).toMatchObject({ state: "synced", anchor: { quantum: 3, bpm: 140 } });
});

test("stale replies, disconnection, sleep and resume invalidate timing", async () => {
  const { service, workers, at } = harness();
  service.configure({ enabled: true, quantum: 4 });
  workers[0].emit(1);
  at(700000);
  expect(service.snapshot()).toMatchObject({ state: "stale", peers: 0 });
  workers[0].emit(1, 0, 4, 120, 700000);
  expect(service.snapshot().state).toBe("stale");
  workers[0].emit(0);
  expect(service.snapshot().state).toBe("local");
  workers[0].emit(1);
  service.setSuspended(true);
  expect(workers[0].stopCalls).toBe(1);
  expect(service.snapshot()).toMatchObject({ clockEpoch: 1, state: "stale" });
  service.setSuspended(false);
  expect(workers).toHaveLength(1);
  workers[0].resolve({ code: 0 });
  await workers[0].done;
  expect(workers).toHaveLength(2);
  workers[1].emit(1);
  expect(service.snapshot()).toMatchObject({ clockEpoch: 2, state: "synced" });
});

test("crash recovery backs off and disabling synchronously cancels the scheduled start", async () => {
  const { service, workers, retry } = harness();
  service.configure({ enabled: true, quantum: 4 });
  workers[0].options.onError("broken protocol");
  workers[0].resolve({ code: 1 });
  await workers[0].done;
  expect(service.diagnostics()).toMatchObject({ state: "retrying", error: "broken protocol" });
  retry();
  expect(workers).toHaveLength(2);
  workers[1].emit(1);
  expect(service.diagnostics()).toMatchObject({ state: "synced", error: null });
  workers[1].resolve({ code: 1 });
  await workers[1].done;
  service.configure({ enabled: false, quantum: 4 });
  retry();
  expect(workers).toHaveLength(2);
  expect(service.snapshot().state).toBe("disabled");
});

test("a rapid disable and re-enable waits for shutdown of the previous process", async () => {
  const { service, workers } = harness();
  service.configure({ enabled: true, quantum: 4 });
  service.configure({ enabled: false, quantum: 4 });
  service.configure({ enabled: true, quantum: 4 });
  expect(workers).toHaveLength(1);
  workers[0].resolve({ code: 0 });
  await workers[0].done;
  expect(workers).toHaveLength(2);
  const quit = service.stop();
  expect(workers[1].stopCalls).toBe(1);
  workers[1].resolve({ code: 0 });
  await quit;
  expect(workers).toHaveLength(2);
});

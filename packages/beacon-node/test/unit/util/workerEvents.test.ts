import {beforeEach, describe, expect, it, vi} from "vitest";

const {terminateMock, subscribeMock} = vi.hoisted(() => ({
  terminateMock: vi.fn(),
  subscribeMock: vi.fn(),
}));

vi.mock("@chainsafe/threads", async (importActual) => {
  const mod = await importActual<typeof import("@chainsafe/threads")>();
  return {
    ...mod,
    Thread: {
      ...mod.Thread,
      terminate: (worker: unknown) => terminateMock(worker),
      events: () => ({subscribe: (cb: (event: {type: string}) => void) => subscribeMock(cb)}),
    },
  };
});

import {terminateWorkerThread} from "../../../src/util/workerEvents.js";

describe("util / workerEvents / terminateWorkerThread", () => {
  beforeEach(() => {
    terminateMock.mockReset();
    subscribeMock.mockReset();
  });

  it("returns true when the worker terminates", async () => {
    let emitTermination: (() => void) | undefined;
    subscribeMock.mockImplementation((cb: (event: {type: string}) => void) => {
      emitTermination = () => cb({type: "termination"});
    });
    terminateMock.mockImplementation(async () => {
      emitTermination?.();
    });

    const result = await terminateWorkerThread({worker: {} as never, retryMs: 50, retryCount: 3});
    expect(result).toBe(true);
  });

  it("returns false in bounded time when the worker never terminates (does not hang)", async () => {
    // Simulate a worker blocked in a native call: terminate() never resolves and no termination
    // event is ever emitted. Before the fix this hung forever on the un-raced terminate().
    subscribeMock.mockImplementation(() => {});
    terminateMock.mockImplementation(() => new Promise(() => {}));

    const retryMs = 20;
    const retryCount = 3;
    const start = Date.now();
    const result = await terminateWorkerThread({worker: {} as never, retryMs, retryCount});
    const elapsed = Date.now() - start;

    expect(result).toBe(false);
    // Bounded by ~retryCount * retryMs; must not hang indefinitely
    expect(elapsed).toBeGreaterThanOrEqual(retryMs);
    expect(elapsed).toBeLessThan(retryMs * retryCount + 2000);
  });

  it("returns false without throwing when Thread.terminate rejects", async () => {
    // A rejecting terminate() (e.g. already-terminated / invalid worker) must be absorbed, not
    // propagate out of the race and abort graceful shutdown.
    subscribeMock.mockImplementation(() => {});
    terminateMock.mockImplementation(async () => {
      throw new Error("worker already terminated");
    });

    const result = await terminateWorkerThread({worker: {} as never, retryMs: 20, retryCount: 3});
    expect(result).toBe(false);
  });
});

import {describe, expect, it} from "vitest";
import {waitForShutdown} from "../../../../src/cmds/builder/handler.js";

describe("builder handler", () => {
  it("waits until the shutdown signal aborts", async () => {
    const controller = new AbortController();

    const waitPromise = waitForShutdown(controller.signal);
    controller.abort();

    await expect(waitPromise).resolves.toBeUndefined();
  });

  it("resolves immediately if the shutdown signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(waitForShutdown(controller.signal)).resolves.toBeUndefined();
  });
});

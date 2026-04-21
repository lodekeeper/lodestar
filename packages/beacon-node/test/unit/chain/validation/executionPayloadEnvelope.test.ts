import {describe, expect, it, vi} from "vitest";
import {validateExecutionPayloadEnvelope} from "../../../../src/chain/validation/executionPayloadEnvelope.js";

describe("validateExecutionPayloadEnvelope", () => {
  it("threads blockInput state into envelope validation", async () => {
    const state = {tag: "expected-state"};
    const processExecutionPayloadEnvelope = vi.fn().mockReturnValue({ok: true});

    const chain: any = {
      processExecutionPayloadEnvelope,
    };

    const blockInput: any = {
      preData: {state},
      postData: {},
      block: {},
    };

    const envelope: any = {};

    await validateExecutionPayloadEnvelope(chain, blockInput, envelope);

    expect(processExecutionPayloadEnvelope).toHaveBeenCalled();
    expect(processExecutionPayloadEnvelope.mock.calls[0][0]).toBe(state);
  });
});

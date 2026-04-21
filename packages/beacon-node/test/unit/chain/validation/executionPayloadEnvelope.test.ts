import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import * as stateTransition from "@lodestar/state-transition";
import {ssz} from "@lodestar/types";
import {toRootHex} from "@lodestar/utils";
import {RegenCaller} from "../../../../src/chain/regen/interface.js";
import {validateGossipExecutionPayloadEnvelope} from "../../../../src/chain/validation/executionPayloadEnvelope.js";
import {MockedBeaconChain, getMockedBeaconChain} from "../../../mocks/mockedBeaconChain.js";

describe("validateGossipExecutionPayloadEnvelope", () => {
  let chain: MockedBeaconChain;

  beforeEach(() => {
    chain = getMockedBeaconChain();
    vi.spyOn(stateTransition, "isStatePostGloas").mockReturnValue(true);
    vi.spyOn(stateTransition, "getExecutionPayloadEnvelopeSignatureSet").mockReturnValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the block state loaded from the forkchoice block stateRoot for signature verification", async () => {
    const signedEnvelope = ssz.gloas.SignedExecutionPayloadEnvelope.defaultValue();
    signedEnvelope.message.slot = 1;
    signedEnvelope.message.builderIndex = 7;
    signedEnvelope.message.payload.blockHash = Buffer.alloc(32, 0x22);

    const block = {
      slot: signedEnvelope.message.slot,
      stateRoot: "0x" + "11".repeat(32),
    };
    const payloadInput = {
      proposerIndex: 13,
      hasPayloadEnvelope: () => false,
      getBuilderIndex: () => signedEnvelope.message.builderIndex,
      getBlockHashHex: () => toRootHex(signedEnvelope.message.payload.blockHash),
    };
    const blockState = {forkName: "gloas"} as never;

    chain.forkChoice.getBlockDefaultStatus.mockReturnValue(block as never);
    chain.forkChoice.getBlockHex.mockReturnValue(null as never);
    chain.forkChoice.getFinalizedCheckpoint.mockReturnValue({epoch: 0} as never);
    chain.seenPayloadEnvelopeInputCache = {
      get: vi.fn().mockReturnValue(payloadInput),
    } as never;
    chain.regen.getState.mockResolvedValue(blockState);
    chain.bls.verifySignatureSets.mockResolvedValue(true);

    await validateGossipExecutionPayloadEnvelope(chain, signedEnvelope);

    expect(chain.regen.getState).toHaveBeenCalledWith(block.stateRoot, RegenCaller.validateGossipPayloadEnvelope);
    expect(stateTransition.getExecutionPayloadEnvelopeSignatureSet).toHaveBeenCalledWith(
      chain.config,
      chain.pubkeyCache,
      blockState,
      signedEnvelope,
      payloadInput.proposerIndex
    );
  });
});

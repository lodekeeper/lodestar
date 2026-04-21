import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {ForkName} from "@lodestar/params";
import * as stateTransition from "@lodestar/state-transition";
import {SignedBeaconBlock, ssz} from "@lodestar/types";
import {toRootHex} from "@lodestar/utils";
import {importExecutionPayload} from "../../../../src/chain/blocks/importExecutionPayload.js";
import {PayloadEnvelopeInput} from "../../../../src/chain/blocks/payloadEnvelopeInput/payloadEnvelopeInput.js";
import {PayloadEnvelopeInputSource} from "../../../../src/chain/blocks/payloadEnvelopeInput/types.js";
import {RegenCaller} from "../../../../src/chain/regen/interface.js";
import {ExecutionPayloadStatus} from "../../../../src/execution/index.js";
import {MockedBeaconChain, getMockedBeaconChain} from "../../../mocks/mockedBeaconChain.js";

function buildPayloadEnvelopeInput(): PayloadEnvelopeInput {
  const block = ssz.gloas.SignedBeaconBlock.defaultValue();
  block.message.slot = 1;
  block.message.proposerIndex = 23;

  const blockRoot = ssz.gloas.BeaconBlock.hashTreeRoot(block.message);
  const blockRootHex = toRootHex(blockRoot);

  const payloadInput = PayloadEnvelopeInput.createFromBlock({
    blockRootHex,
    block: block as SignedBeaconBlock<typeof ForkName.gloas>,
    forkName: ForkName.gloas,
    sampledColumns: [],
    custodyColumns: [],
    timeCreatedSec: Date.now() / 1000,
  });

  const signedEnvelope = ssz.gloas.SignedExecutionPayloadEnvelope.defaultValue();
  signedEnvelope.message.beaconBlockRoot = blockRoot;
  signedEnvelope.message.slot = block.message.slot;
  signedEnvelope.message.builderIndex = payloadInput.getBuilderIndex();
  signedEnvelope.message.payload.blockHash = block.message.body.signedExecutionPayloadBid.message.blockHash;
  signedEnvelope.message.stateRoot = Buffer.alloc(32, 0x33);

  payloadInput.addPayloadEnvelope({
    envelope: signedEnvelope,
    source: PayloadEnvelopeInputSource.gossip,
    seenTimestampSec: Date.now() / 1000,
  });

  return payloadInput;
}

describe("importExecutionPayload", () => {
  let chain: MockedBeaconChain;

  beforeEach(() => {
    chain = getMockedBeaconChain();
    vi.spyOn(stateTransition, "isStatePostGloas").mockReturnValue(true);
    vi.spyOn(stateTransition, "getExecutionPayloadEnvelopeSignatureSet").mockReturnValue({} as never);

    chain.executionEngine.notifyNewPayload = vi.fn().mockResolvedValue({
      status: ExecutionPayloadStatus.VALID,
    }) as never;
    chain.unfinalizedPayloadEnvelopeWrites = {
      waitForSpace: vi.fn().mockResolvedValue(undefined),
      push: vi.fn().mockResolvedValue(undefined),
    } as never;
    chain.forkChoice.onExecutionPayload = vi.fn() as never;
    chain.regen.processState = vi.fn() as never;
    chain.regen.addCheckpointState = vi.fn() as never;
    chain.metrics = null as never;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("threads regen block-slot state into signature verification and payload processing", async () => {
    const payloadInput = buildPayloadEnvelopeInput();
    const signedEnvelope = payloadInput.getPayloadEnvelope();
    const protoBlock = {
      slot: signedEnvelope.message.slot,
      parentRoot: "0x" + "44".repeat(32),
    };
    const blockState = {
      forkName: "gloas",
      processExecutionPayloadEnvelope: vi.fn(),
    };
    const postPayloadState = {
      slot: 1,
      hashTreeRoot: vi.fn().mockReturnValue(signedEnvelope.message.stateRoot),
      computeAnchorCheckpoint: vi.fn(),
    };
    blockState.processExecutionPayloadEnvelope.mockReturnValue(postPayloadState);

    chain.forkChoice.getBlockHexDefaultStatus.mockReturnValue(protoBlock as never);
    chain.regen.getBlockSlotState.mockResolvedValue(blockState as never);
    chain.bls.verifySignatureSets.mockResolvedValue(true);

    await importExecutionPayload.call(chain, payloadInput, new AbortController().signal);

    expect(chain.regen.getBlockSlotState).toHaveBeenCalledWith(
      protoBlock,
      protoBlock.slot,
      {dontTransferCache: true},
      RegenCaller.processBlock
    );
    expect(stateTransition.getExecutionPayloadEnvelopeSignatureSet).toHaveBeenCalledWith(
      chain.config,
      chain.pubkeyCache,
      blockState,
      signedEnvelope,
      payloadInput.proposerIndex
    );
    expect(blockState.processExecutionPayloadEnvelope).toHaveBeenCalledWith(signedEnvelope, {
      verifySignature: false,
      verifyStateRoot: false,
    });
  });
});

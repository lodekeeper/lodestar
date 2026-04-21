import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {PayloadStatus} from "@lodestar/fork-choice";
import {ForkName} from "@lodestar/params";
import {SignedBeaconBlock, ssz} from "@lodestar/types";
import {toRootHex} from "@lodestar/utils";
import {getBeaconBlockApi} from "../../../../../../src/api/impl/beacon/blocks/index.js";
import {PayloadEnvelopeInput} from "../../../../../../src/chain/blocks/payloadEnvelopeInput/payloadEnvelopeInput.js";
import {PayloadEnvelopeInputSource} from "../../../../../../src/chain/blocks/payloadEnvelopeInput/types.js";
import * as validationModule from "../../../../../../src/chain/validation/executionPayloadEnvelope.js";
import {ApiTestModules, getApiTestModules} from "../../../../../utils/api.js";

function buildPayloadInputAndEnvelope(): {
  payloadInput: PayloadEnvelopeInput;
  signedEnvelope: ReturnType<typeof ssz.gloas.SignedExecutionPayloadEnvelope.defaultValue>;
  blockRootHex: string;
} {
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

  return {payloadInput, signedEnvelope, blockRootHex};
}

describe("api - beacon - publishExecutionPayloadEnvelope", () => {
  let modules: ApiTestModules;
  let api: ReturnType<typeof getBeaconBlockApi>;

  beforeEach(() => {
    modules = getApiTestModules();
    api = getBeaconBlockApi(modules);
    vi.spyOn(modules.config, "getForkName").mockReturnValue(ForkName.gloas);
    vi.spyOn(validationModule, "validateApiExecutionPayloadEnvelope").mockResolvedValue();

    modules.network.publishSignedExecutionPayloadEnvelope = vi.fn().mockResolvedValue(2) as never;
    modules.chain.processExecutionPayload = vi.fn().mockResolvedValue(undefined) as never;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses the cached payload input and passes it to processExecutionPayload after API validation", async () => {
    const {payloadInput, signedEnvelope, blockRootHex} = buildPayloadInputAndEnvelope();

    modules.forkChoice.getBlockHex.mockReturnValue({slot: signedEnvelope.message.slot} as never);
    modules.chain.seenPayloadEnvelopeInputCache = {
      get: vi.fn().mockReturnValue(payloadInput),
    } as never;

    await api.publishExecutionPayloadEnvelope({signedExecutionPayloadEnvelope: signedEnvelope});

    expect(validationModule.validateApiExecutionPayloadEnvelope).toHaveBeenCalledWith(modules.chain, signedEnvelope);
    expect(modules.forkChoice.getBlockHex).toHaveBeenCalledWith(blockRootHex, PayloadStatus.EMPTY);
    expect(payloadInput.hasPayloadEnvelope()).toBe(true);
    expect(payloadInput.getPayloadEnvelope()).toBe(signedEnvelope);
    expect(payloadInput.getPayloadEnvelopeSource().source).toBe(PayloadEnvelopeInputSource.api);
    expect(modules.chain.processExecutionPayload).toHaveBeenCalledWith(payloadInput, {validSignature: true});
    expect(modules.network.publishSignedExecutionPayloadEnvelope).toHaveBeenCalledWith(signedEnvelope);
  });
});

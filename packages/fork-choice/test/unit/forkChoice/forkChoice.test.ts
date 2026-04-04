import {beforeAll, beforeEach, describe, expect, it} from "vitest";
import {fromHexString} from "@chainsafe/ssz";
import {config} from "@lodestar/config/default";
import {SLOTS_PER_EPOCH} from "@lodestar/params";
import {DataAvailabilityStatus, computeEpochAtSlot} from "@lodestar/state-transition";
import {IndexedAttestation, RootHex, Slot, ssz} from "@lodestar/types";
import {toHex} from "@lodestar/utils";
import {
  EpochDifference,
  ExecutionStatus,
  ForkChoice,
  ForkChoiceError,
  ForkChoiceErrorCode,
  IForkChoiceStore,
  InvalidAttestationCode,
  PayloadStatus,
  ProtoArray,
  ProtoBlock,
} from "../../../src/index.js";
import {getBlockRoot, getStateRoot} from "../../utils/index.js";

describe("Forkchoice", () => {
  const genesisSlot = 0;
  const genesisEpoch = 0;
  const genesisRoot = "0x0000000000000000000000000000000000000000000000000000000000000000";

  const finalizedRoot = getBlockRoot(genesisSlot);
  const parentRoot = toHex(Buffer.alloc(32, 0xff));
  let protoArr: ProtoArray;
  let fcStore: IForkChoiceStore;
  const validatorCount = 100;

  beforeEach(() => {
    protoArr = ProtoArray.initialize(
      {
        slot: genesisSlot,
        stateRoot: getStateRoot(genesisSlot),
        parentRoot,
        blockRoot: finalizedRoot,

        justifiedEpoch: genesisEpoch,
        justifiedRoot: genesisRoot,
        finalizedEpoch: genesisEpoch,
        finalizedRoot: genesisRoot,

        executionPayloadBlockHash: null,
        executionStatus: ExecutionStatus.PreMerge,
        dataAvailabilityStatus: DataAvailabilityStatus.PreData,

        // Pre-Gloas block fields (required to avoid being treated as Gloas)
        parentBlockHash: null,
        payloadStatus: PayloadStatus.FULL,
        timeliness: false,
      } as Omit<ProtoBlock, "targetRoot">,
      genesisSlot
    );
    fcStore = {
      currentSlot: genesisSlot + 1,
      justified: {
        checkpoint: {
          epoch: genesisEpoch,
          root: fromHexString(finalizedRoot),
          rootHex: finalizedRoot,
          payloadStatus: PayloadStatus.FULL,
        },
        balances: new Uint16Array([32]),
        totalBalance: 32,
      },
      unrealizedJustified: {
        checkpoint: {
          epoch: genesisEpoch,
          root: fromHexString(finalizedRoot),
          rootHex: finalizedRoot,
          payloadStatus: PayloadStatus.FULL,
        },
        balances: new Uint16Array([32]),
      },
      finalizedCheckpoint: {
        epoch: genesisEpoch,
        root: fromHexString(finalizedRoot),
        rootHex: finalizedRoot,
        payloadStatus: PayloadStatus.FULL,
      },
      unrealizedFinalizedCheckpoint: {
        epoch: genesisEpoch,
        root: fromHexString(finalizedRoot),
        rootHex: finalizedRoot,
        payloadStatus: PayloadStatus.FULL,
      },
      justifiedBalancesGetter: () => new Uint16Array([32]),
      equivocatingIndices: new Set(),
    };
  });

  const getParentBlockRoot = (slot: number, skippedSlots: number[] = []): RootHex => {
    slot -= 1;
    while (slot >= 0) {
      if (!skippedSlots.includes(slot)) return getBlockRoot(slot);
      slot -= 1;
    }
    throw Error("Not found parent slot for slot" + slot);
  };

  const getTargetRoot = (slot: number, skippedSlots: number[] = []): RootHex => {
    let targetSlot = computeEpochAtSlot(slot) * SLOTS_PER_EPOCH;
    if (targetSlot === genesisSlot) return finalizedRoot;
    while (targetSlot >= 0) {
      if (!skippedSlots.includes(targetSlot)) return getBlockRoot(targetSlot);
      targetSlot -= 1;
    }
    throw Error("Not found target slot for slot " + slot);
  };

  const getBlock = (slot: number, skippedSlots: number[] = []): ProtoBlock => {
    return {
      slot,
      blockRoot: getBlockRoot(slot),
      parentRoot: getParentBlockRoot(slot, skippedSlots),
      stateRoot: getStateRoot(slot),
      targetRoot: getTargetRoot(slot, skippedSlots),

      justifiedEpoch: genesisEpoch,
      justifiedRoot: genesisRoot,
      finalizedEpoch: genesisEpoch,
      finalizedRoot: genesisRoot,
      unrealizedJustifiedEpoch: genesisEpoch,
      unrealizedJustifiedRoot: genesisRoot,
      unrealizedFinalizedEpoch: genesisEpoch,
      unrealizedFinalizedRoot: genesisRoot,

      executionPayloadBlockHash: null,
      executionStatus: ExecutionStatus.PreMerge,

      timeliness: false,
      dataAvailabilityStatus: DataAvailabilityStatus.PreData,

      parentBlockHash: null,
      payloadStatus: PayloadStatus.FULL,
    };
  };

  const getPayloadHash = (slot: number): RootHex => toHex(Buffer.alloc(32, slot + 1));

  const getGloasBlock = (slot: number): ProtoBlock => {
    const block = getBlock(slot);
    return {
      ...block,
      executionPayloadBlockHash: getPayloadHash(slot),
      executionPayloadNumber: slot,
      executionStatus: ExecutionStatus.PayloadSeparated,
      dataAvailabilityStatus: DataAvailabilityStatus.Available,
      parentBlockHash: getPayloadHash(slot + 64),
      payloadStatus: PayloadStatus.PENDING,
    };
  };

  const getAttestationDataRoot = (attestation: IndexedAttestation): RootHex =>
    toHex(ssz.phase0.AttestationData.hashTreeRoot(attestation.data));

  const createAttestation = (block: ProtoBlock, slot: Slot, index: number, validatorIndex = 0): IndexedAttestation => ({
    attestingIndices: [validatorIndex],
    data: {
      slot,
      index,
      beaconBlockRoot: fromHexString(block.blockRoot),
      source: {
        epoch: computeEpochAtSlot(slot),
        root: fromHexString(block.targetRoot),
      },
      target: {
        epoch: computeEpochAtSlot(slot),
        root: fromHexString(block.targetRoot),
      },
    },
    signature: Buffer.alloc(96),
  });

  const getVoteNextIndices = (forkchoice: ForkChoice): number[] =>
    Reflect.get(forkchoice, "voteNextIndices") as number[];

  const expectInvalidAttestation = (
    action: () => void,
    code: InvalidAttestationCode
  ): Extract<ForkChoiceError["type"], {code: ForkChoiceErrorCode.INVALID_ATTESTATION}>["err"] => {
    try {
      action();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ForkChoiceError);
      if (!(error instanceof ForkChoiceError)) {
        throw error;
      }

      const {type} = error;
      expect(type.code).toBe(ForkChoiceErrorCode.INVALID_ATTESTATION);
      if (type.code !== ForkChoiceErrorCode.INVALID_ATTESTATION) {
        throw error;
      }

      expect(type.err.code).toBe(code);
      return type.err;
    }

    throw new Error(`Expected INVALID_ATTESTATION ${code}`);
  };

  const populateProtoArray = (tillSlot: number, skippedSlots: number[] = []): void => {
    for (let slot = genesisSlot + 1; slot <= tillSlot; slot++) {
      if (!skippedSlots.includes(slot)) {
        const block = getBlock(slot, skippedSlots);
        protoArr.onBlock(block, block.slot, null);
      }
    }
  };

  it("getAllAncestorBlocks", () => {
    // Add block that is a finalized descendant.
    const block = getBlock(genesisSlot + 1);
    protoArr.onBlock(block, block.slot, null);
    const forkchoice = new ForkChoice(config, fcStore, protoArr, validatorCount, null);
    const summaries = forkchoice.getAllAncestorBlocks(getBlockRoot(genesisSlot + 1), PayloadStatus.FULL);
    // there are 2 blocks in protoArray but iterateAncestorBlocks should only return non-finalized blocks
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual({
      ...block,
      bestChild: undefined,
      bestDescendant: undefined,
      parent: 0,
      weight: 0,
      payloadStatus: 2, // Pre-Gloas blocks always have PAYLOAD_STATUS_FULL
    });
  });

  it("getAllAncestorAndNonAncestorBlocks equals getAllAncestorBlocks + getAllNonAncestorBlocks", () => {
    // Create a simple chain: 0 -> 1 -> 2 -> 3
    populateProtoArray(genesisSlot + 3);

    // Create a fork by adding block 10 with parent at genesis
    const forkBlock = {
      ...getBlock(genesisSlot + 10),
      parentRoot: finalizedRoot, // Connect directly to genesis
    };
    protoArr.onBlock(forkBlock, forkBlock.slot, null);

    const forkchoice = new ForkChoice(config, fcStore, protoArr, validatorCount, null);

    // Test with a block from the canonical chain
    const canonicalBlockRoot = getBlockRoot(genesisSlot + 3);
    const canonicalAncestorBlocks = forkchoice.getAllAncestorBlocks(canonicalBlockRoot, PayloadStatus.FULL);
    const canonicalNonAncestorBlocks = forkchoice.getAllNonAncestorBlocks(canonicalBlockRoot, PayloadStatus.FULL);
    const canonicalCombined = forkchoice.getAllAncestorAndNonAncestorBlocks(canonicalBlockRoot, PayloadStatus.FULL);

    expect(canonicalCombined.ancestors).toEqual(canonicalAncestorBlocks);
    expect(canonicalCombined.nonAncestors).toEqual(canonicalNonAncestorBlocks);

    // Test with a block from the fork chain
    const forkBlockRoot = getBlockRoot(genesisSlot + 10);
    const forkAncestorBlocks = forkchoice.getAllAncestorBlocks(forkBlockRoot, PayloadStatus.FULL);
    const forkNonAncestorBlocks = forkchoice.getAllNonAncestorBlocks(forkBlockRoot, PayloadStatus.FULL);
    const forkCombined = forkchoice.getAllAncestorAndNonAncestorBlocks(forkBlockRoot, PayloadStatus.FULL);

    expect(forkCombined.ancestors).toEqual(forkAncestorBlocks);
    expect(forkCombined.nonAncestors).toEqual(forkNonAncestorBlocks);
  });

  describe("Gloas attestation index validation", () => {
    it("same-slot index=0 succeeds and maps to PENDING", () => {
      const block = getGloasBlock(genesisSlot + 1);
      protoArr.onBlock(block, block.slot, null);
      fcStore.currentSlot = block.slot;

      const forkchoice = new ForkChoice(config, fcStore, protoArr, validatorCount, null);
      const attestation = createAttestation(block, block.slot, 0);

      forkchoice.onAttestation(attestation, getAttestationDataRoot(attestation));
      forkchoice.updateTime(block.slot + 1);

      const pendingIndex = protoArr.getNodeIndexByRootAndStatus(block.blockRoot, PayloadStatus.PENDING);
      expect(pendingIndex).toBeDefined();
      expect(getVoteNextIndices(forkchoice)[0]).toBe(pendingIndex);
    });

    it("same-slot index=1 throws INVALID_DATA_INDEX", () => {
      const block = getGloasBlock(genesisSlot + 1);
      protoArr.onBlock(block, block.slot, null);
      fcStore.currentSlot = block.slot;

      const forkchoice = new ForkChoice(config, fcStore, protoArr, validatorCount, null);
      const attestation = createAttestation(block, block.slot, 1);

      expectInvalidAttestation(
        () => forkchoice.onAttestation(attestation, getAttestationDataRoot(attestation)),
        InvalidAttestationCode.INVALID_DATA_INDEX
      );
    });

    it("later-slot index=1 without FULL variant throws UNKNOWN_PAYLOAD_STATUS", () => {
      const block = getGloasBlock(genesisSlot + 1);
      protoArr.onBlock(block, block.slot, null);
      fcStore.currentSlot = block.slot + 1;

      const forkchoice = new ForkChoice(config, fcStore, protoArr, validatorCount, null);
      const attestation = createAttestation(block, block.slot + 1, 1);

      const err = expectInvalidAttestation(
        () => forkchoice.onAttestation(attestation, getAttestationDataRoot(attestation)),
        InvalidAttestationCode.UNKNOWN_PAYLOAD_STATUS
      );

      if (!("beaconBlockRoot" in err)) {
        throw new Error("Expected UNKNOWN_PAYLOAD_STATUS error payload");
      }
      expect(err.beaconBlockRoot).toBe(block.blockRoot);
    });

    it("later-slot index=1 with FULL variant succeeds and maps to FULL", () => {
      const block = getGloasBlock(genesisSlot + 1);
      protoArr.onBlock(block, block.slot, null);
      protoArr.onExecutionPayload(
        block.blockRoot,
        block.slot + 1,
        getPayloadHash(block.slot),
        block.slot,
        block.stateRoot,
        null,
        ExecutionStatus.Valid
      );
      fcStore.currentSlot = block.slot + 1;

      const forkchoice = new ForkChoice(config, fcStore, protoArr, validatorCount, null);
      const attestation = createAttestation(block, block.slot + 1, 1);

      forkchoice.onAttestation(attestation, getAttestationDataRoot(attestation));
      forkchoice.updateTime(block.slot + 2);

      const fullIndex = protoArr.getNodeIndexByRootAndStatus(block.blockRoot, PayloadStatus.FULL);
      expect(fullIndex).toBeDefined();
      expect(getVoteNextIndices(forkchoice)[0]).toBe(fullIndex);
    });

    it("same-slot index=1 still throws INVALID_DATA_INDEX when FULL variant is known", () => {
      const block = getGloasBlock(genesisSlot + 1);
      protoArr.onBlock(block, block.slot, null);
      protoArr.onExecutionPayload(
        block.blockRoot,
        block.slot,
        getPayloadHash(block.slot),
        block.slot,
        block.stateRoot,
        null,
        ExecutionStatus.Valid
      );
      fcStore.currentSlot = block.slot;

      const forkchoice = new ForkChoice(config, fcStore, protoArr, validatorCount, null);
      const attestation = createAttestation(block, block.slot, 1);

      expectInvalidAttestation(
        () => forkchoice.onAttestation(attestation, getAttestationDataRoot(attestation)),
        InvalidAttestationCode.INVALID_DATA_INDEX
      );
    });

    it("later-slot index=1 succeeds after FULL variant arrives (retry)", () => {
      const block = getGloasBlock(genesisSlot + 1);
      protoArr.onBlock(block, block.slot, null);
      fcStore.currentSlot = block.slot + 1;

      const forkchoice = new ForkChoice(config, fcStore, protoArr, validatorCount, null);
      const attestation = createAttestation(block, block.slot + 1, 1);
      const attDataRoot = getAttestationDataRoot(attestation);

      // First attempt: FULL variant not known yet → UNKNOWN_PAYLOAD_STATUS
      expectInvalidAttestation(
        () => forkchoice.onAttestation(attestation, attDataRoot),
        InvalidAttestationCode.UNKNOWN_PAYLOAD_STATUS
      );

      // Import FULL variant
      protoArr.onExecutionPayload(
        block.blockRoot,
        block.slot + 1,
        getPayloadHash(block.slot),
        block.slot,
        block.stateRoot,
        null,
        ExecutionStatus.Valid
      );

      // Second attempt with same attestation data → should succeed now
      forkchoice.onAttestation(attestation, attDataRoot);
      forkchoice.updateTime(block.slot + 2);

      const fullIndex = protoArr.getNodeIndexByRootAndStatus(block.blockRoot, PayloadStatus.FULL);
      expect(fullIndex).toBeDefined();
      expect(getVoteNextIndices(forkchoice)[0]).toBe(fullIndex);
    });

    it("later-slot index=0 maps to EMPTY", () => {
      const block = getGloasBlock(genesisSlot + 1);
      protoArr.onBlock(block, block.slot, null);
      fcStore.currentSlot = block.slot + 1;

      const forkchoice = new ForkChoice(config, fcStore, protoArr, validatorCount, null);
      const attestation = createAttestation(block, block.slot + 1, 0);

      forkchoice.onAttestation(attestation, getAttestationDataRoot(attestation));
      forkchoice.updateTime(block.slot + 2);

      const emptyIndex = protoArr.getNodeIndexByRootAndStatus(block.blockRoot, PayloadStatus.EMPTY);
      expect(emptyIndex).toBeDefined();
      expect(getVoteNextIndices(forkchoice)[0]).toBe(emptyIndex);
    });
  });

  beforeAll(() => {
    expect(SLOTS_PER_EPOCH).toBe(32);
  });

  const dependentRootTestCases: {atSlot: Slot; pivotSlot: Slot; epoch: EpochDifference; skipped: Slot[]}[] = [
    // First slot in epoch request, EpochDifference.current
    {atSlot: 32, pivotSlot: 31, epoch: EpochDifference.current, skipped: []},
    {atSlot: 32, pivotSlot: 30, epoch: EpochDifference.current, skipped: [31]},
    {atSlot: 32, pivotSlot: 8, epoch: EpochDifference.current, skipped: range(9, 31)},
    {atSlot: 32, pivotSlot: 0, epoch: EpochDifference.current, skipped: range(1, 31)},
    // First slot in epoch request, EpochDifference.previous
    {atSlot: 64, pivotSlot: 31, epoch: EpochDifference.previous, skipped: []},
    {atSlot: 64, pivotSlot: 30, epoch: EpochDifference.previous, skipped: [31]},
    {atSlot: 64, pivotSlot: 8, epoch: EpochDifference.previous, skipped: range(9, 32)},
    {atSlot: 64, pivotSlot: 0, epoch: EpochDifference.previous, skipped: range(1, 32)},
    // Mid slot in epoch request, EpochDifference.previous
    {atSlot: 64 + 1, pivotSlot: 31, epoch: EpochDifference.previous, skipped: []},
    {atSlot: 64 + 8, pivotSlot: 31, epoch: EpochDifference.previous, skipped: []},
    {atSlot: 64 + 31, pivotSlot: 31, epoch: EpochDifference.previous, skipped: []},
    // Underflow up to genesis
    {atSlot: 31, pivotSlot: 0, epoch: EpochDifference.current, skipped: []},
    {atSlot: 8, pivotSlot: 0, epoch: EpochDifference.current, skipped: []},
    {atSlot: 0, pivotSlot: 0, epoch: EpochDifference.current, skipped: []},
    {atSlot: 32, pivotSlot: 0, epoch: EpochDifference.previous, skipped: []},
    {atSlot: 8, pivotSlot: 0, epoch: EpochDifference.previous, skipped: []},
    {atSlot: 0, pivotSlot: 0, epoch: EpochDifference.previous, skipped: []},
  ];

  for (const {atSlot, pivotSlot, epoch, skipped} of dependentRootTestCases) {
    it(`getDependentRoot epoch ${epoch} atSlot ${atSlot} skipped ${JSON.stringify(skipped)}`, () => {
      populateProtoArray(atSlot, skipped);
      const forkchoice = new ForkChoice(config, fcStore, protoArr, validatorCount, null);

      const blockRoot = getBlockRoot(atSlot);
      const block = forkchoice.getBlockHexDefaultStatus(blockRoot);
      if (!block) throw Error(`No block for blockRoot ${blockRoot}`);

      const expectedDependentRoot = getBlockRoot(pivotSlot);

      expect(forkchoice.getDependentRoot(block, epoch)).toBe(expectedDependentRoot);
    });
  }

  // TODO: more unit tests for other apis
});

function range(from: number, toInclusive: number): number[] {
  const arr: number[] = [];
  for (let i = from; i <= toInclusive; i++) {
    arr.push(i);
  }
  return arr;
}

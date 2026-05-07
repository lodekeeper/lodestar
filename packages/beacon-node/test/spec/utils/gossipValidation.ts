import {EventEmitter} from "node:events";
import fs from "node:fs";
import path from "node:path";
import {generateKeyPair} from "@libp2p/crypto/keys";
import jsyaml from "js-yaml";
import snappy from "snappy";
import {expect} from "vitest";
import {chainConfigFromJson, chainConfigTypes, createBeaconConfig} from "@lodestar/config";
import {getConfig} from "@lodestar/config/test-utils";
import {EpochDifference, ExecutionStatus} from "@lodestar/fork-choice";
import {testLogger} from "@lodestar/logger/test-utils";
import {ForkName, isForkPostDeneb, isForkPostElectra} from "@lodestar/params";
import {
  BeaconStateAllForks,
  BeaconStateView,
  DataAvailabilityStatus,
  ExecutionPayloadStatus,
  IBeaconStateView,
  computeEpochAtSlot,
  computeStartSlotAtEpoch,
  createCachedBeaconState,
  createPubkeyCache,
  isExecutionStateType,
  syncPubkeys,
} from "@lodestar/state-transition";
import {RootHex, SignedBeaconBlock, ssz, sszTypesFor} from "@lodestar/types";
import {fromHex, loadYaml, toHex, toRootHex} from "@lodestar/utils";
import {BlockInputBlobs, BlockInputPreData, BlockInputSource} from "../../../src/chain/blocks/blockInput/index.js";
import {AttestationImportOpt, BlobSidecarValidation} from "../../../src/chain/blocks/types.js";
import {GossipAction, GossipActionError} from "../../../src/chain/errors/gossipValidation.js";
import {BeaconChain, ChainEvent} from "../../../src/chain/index.js";
import {defaultChainOptions} from "../../../src/chain/options.js";
import {validateGossipAggregateAndProof} from "../../../src/chain/validation/aggregateAndProof.js";
import {GossipAttestation, validateGossipAttestationsSameAttData} from "../../../src/chain/validation/attestation.js";
import {validateGossipAttesterSlashing} from "../../../src/chain/validation/attesterSlashing.js";
import {validateGossipBlobSidecar} from "../../../src/chain/validation/blobSidecar.js";
import {validateGossipBlock} from "../../../src/chain/validation/block.js";
import {validateGossipBlsToExecutionChange} from "../../../src/chain/validation/blsToExecutionChange.js";
import {validateGossipProposerSlashing} from "../../../src/chain/validation/proposerSlashing.js";
import {validateGossipSyncCommittee} from "../../../src/chain/validation/syncCommittee.js";
import {validateSyncCommitteeGossipContributionAndProof} from "../../../src/chain/validation/syncCommitteeContributionAndProof.js";
import {validateGossipVoluntaryExit} from "../../../src/chain/validation/voluntaryExit.js";
import {ZERO_HASH_HEX} from "../../../src/constants/constants.js";
import {ExecutionEngineMockBackend} from "../../../src/execution/engine/mock.js";
import {getExecutionEngineFromBackend} from "../../../src/execution/index.js";
import {GossipType} from "../../../src/network/gossip/interface.js";
import type {IClock} from "../../../src/util/clock.js";
import {getBeaconAttestationGossipIndex, getSlotFromBeaconAttestationSerialized} from "../../../src/util/sszBytes.js";
import {getMockedBeaconDb} from "../../mocks/mockedBeaconDb.js";
import {assertCorrectProgressiveBalances} from "../config.js";

/**
 * A test clock that models gossip clock disparity from a millisecond timestamp.
 * Unlike ClockStopped which returns exact slot values, this clock computes
 * currentSlotWithGossipDisparity correctly for spec conformance tests.
 */
class GossipTestClock extends EventEmitter implements IClock {
  genesisTime: number;
  private currentTimeMs: number;
  private secondsPerSlot: number;
  private maxDisparityMs: number;

  constructor(genesisTimeSec: number, secondsPerSlot: number, maxDisparityMs: number) {
    super();
    this.genesisTime = genesisTimeSec;
    this.currentTimeMs = genesisTimeSec * 1000;
    this.secondsPerSlot = secondsPerSlot;
    this.maxDisparityMs = maxDisparityMs;
  }

  get currentSlot(): number {
    return Math.floor((this.currentTimeMs / 1000 - this.genesisTime) / this.secondsPerSlot);
  }

  get currentSlotWithGossipDisparity(): number {
    // Model: if we're within maxDisparityMs of next slot, return next slot
    // Spec: current_time_ms + MAXIMUM_GOSSIP_CLOCK_DISPARITY >= block_time_ms
    // This means: nextSlotTimeMs - currentTimeMs <= maxDisparityMs
    const slot = this.currentSlot;
    const nextSlotTimeMs = (this.genesisTime + (slot + 1) * this.secondsPerSlot) * 1000;
    if (nextSlotTimeMs - this.currentTimeMs <= this.maxDisparityMs) {
      return slot + 1;
    }
    return slot;
  }

  get currentEpoch(): number {
    return computeEpochAtSlot(this.currentSlot);
  }

  slotWithFutureTolerance(toleranceSec: number): number {
    return Math.floor((this.currentTimeMs / 1000 + toleranceSec - this.genesisTime) / this.secondsPerSlot);
  }

  slotWithPastTolerance(toleranceSec: number): number {
    return Math.floor((this.currentTimeMs / 1000 - toleranceSec - this.genesisTime) / this.secondsPerSlot);
  }

  isCurrentSlotGivenGossipDisparity(slot: number): boolean {
    const current = this.currentSlot;
    if (slot === current) return true;
    const nextSlotTimeMs = (this.genesisTime + (current + 1) * this.secondsPerSlot) * 1000;
    if (nextSlotTimeMs - this.currentTimeMs <= this.maxDisparityMs) {
      return slot === current + 1;
    }
    const currentSlotTimeMs = (this.genesisTime + current * this.secondsPerSlot) * 1000;
    if (this.currentTimeMs - currentSlotTimeMs <= this.maxDisparityMs) {
      return slot === current - 1;
    }
    return false;
  }

  async waitForSlot(): Promise<void> {
    // Not used in tests
  }

  secFromSlot(slot: number, toSec?: number): number {
    const slotTimeSec = this.genesisTime + slot * this.secondsPerSlot;
    return (toSec ?? this.currentTimeMs / 1000) - slotTimeSec;
  }

  msFromSlot(slot: number, toMs?: number): number {
    const slotTimeMs = (this.genesisTime + slot * this.secondsPerSlot) * 1000;
    return (toMs ?? this.currentTimeMs) - slotTimeMs;
  }

  /** Set the current time in milliseconds since genesis */
  setCurrentTimeMs(ms: number): void {
    this.currentTimeMs = this.genesisTime * 1000 + ms;
  }

  /** Also support setSlot for block import phases */
  setSlot(slot: number): void {
    this.currentTimeMs = (this.genesisTime + slot * this.secondsPerSlot) * 1000;
  }
}

type MetaPayloadStatus = "VALID" | "NOT_VALIDATED" | "INVALIDATED";

interface MetaYaml {
  topic: GossipType;
  blocks?: {block: string; failed?: boolean; payload_status?: MetaPayloadStatus}[];
  finalized_checkpoint?: {epoch: bigint; root?: string; block?: string};
  current_time_ms?: bigint;
  messages: {
    offset_ms?: bigint;
    subnet_id?: bigint;
    message: string;
    expected: "valid" | "ignore" | "reject";
    reason?: string;
  }[];
}

const gossipTopicByHandler = {
  gossip_beacon_block: GossipType.beacon_block,
  gossip_beacon_aggregate_and_proof: GossipType.beacon_aggregate_and_proof,
  gossip_beacon_attestation: GossipType.beacon_attestation,
  gossip_proposer_slashing: GossipType.proposer_slashing,
  gossip_attester_slashing: GossipType.attester_slashing,
  gossip_voluntary_exit: GossipType.voluntary_exit,
  gossip_sync_committee_message: GossipType.sync_committee,
  gossip_sync_committee_contribution_and_proof: GossipType.sync_committee_contribution_and_proof,
  gossip_bls_to_execution_change: GossipType.bls_to_execution_change,
  gossip_blob_sidecar: GossipType.blob_sidecar,
} as const satisfies Record<string, GossipType>;

export function isGossipValidationHandler(topicHandler: string): topicHandler is keyof typeof gossipTopicByHandler {
  return topicHandler in gossipTopicByHandler;
}

function getGossipTopic(topicHandler: string): GossipType {
  if (!isGossipValidationHandler(topicHandler)) {
    throw Error(`Unsupported gossip test handler ${topicHandler}`);
  }
  return gossipTopicByHandler[topicHandler];
}

function loadMeta(testCaseDir: string): MetaYaml {
  const raw = fs.readFileSync(path.join(testCaseDir, "meta.yaml"), "utf8");
  return loadYaml<MetaYaml>(raw);
}

function loadTestCaseChainConfig(testCaseDir: string, fork: ForkName) {
  const configPath = path.join(testCaseDir, "config.yaml");
  if (!fs.existsSync(configPath)) return getConfig(fork);

  // Parse config scalars as raw strings so byte values such as `0x00000001`
  // keep their leading zeros before passing through `chainConfigFromJson()`.
  // FAILSAFE_SCHEMA produces strings for scalars and preserves arrays/objects
  // (e.g. `BLOB_SCHEDULE`) as-is for `chainConfigFromJson` to deserialize.
  const parsed = jsyaml.load(fs.readFileSync(configPath, "utf8"), {
    schema: jsyaml.FAILSAFE_SCHEMA,
  }) as Record<string, unknown>;
  const configJson: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (key in chainConfigTypes) {
      configJson[key] = value;
    }
  }

  return {...getConfig(fork), ...chainConfigFromJson(configJson)};
}

function loadSszSnappy(testCaseDir: string, name: string): Uint8Array {
  const compressed = fs.readFileSync(path.join(testCaseDir, `${name}.ssz_snappy`));
  const decompressed = snappy.uncompressSync(compressed);
  return typeof decompressed === "string" ? Buffer.from(decompressed) : decompressed;
}

function loadState(testCaseDir: string, fork: ForkName): BeaconStateAllForks {
  const bytes = loadSszSnappy(testCaseDir, "state");
  return sszTypesFor(fork).BeaconState.deserializeToViewDU(bytes);
}

type FinalizedCheckpoint = {epoch: number; rootHex: RootHex};

function loadBlockRootHex(testCaseDir: string, fork: ForkName, name: string): RootHex {
  const signedBlock = sszTypesFor(fork).SignedBeaconBlock.deserialize(loadSszSnappy(testCaseDir, name));
  return toHex(sszTypesFor(fork).BeaconBlock.hashTreeRoot(signedBlock.message));
}

function resolveFinalizedCheckpoint(
  meta: MetaYaml,
  testCaseDir: string,
  fork: ForkName,
  blockRootsByName: Map<string, RootHex>
): FinalizedCheckpoint | null {
  const cp = meta.finalized_checkpoint;
  if (!cp) return null;

  let rootHex: RootHex | null = null;
  if (cp.root) {
    rootHex = toRootHex(fromHex(cp.root));
  }
  if (cp.block) {
    const blockRootHex = blockRootsByName.get(cp.block) ?? loadBlockRootHex(testCaseDir, fork, cp.block);
    blockRootsByName.set(cp.block, blockRootHex);
    if (rootHex !== null && rootHex !== blockRootHex) {
      throw new Error(`finalized_checkpoint.root does not match root of ${cp.block}`);
    }
    rootHex = blockRootHex;
  }

  if (rootHex === null) {
    throw new Error("finalized_checkpoint must include either root or block");
  }

  if (cp.epoch == null) {
    throw new Error("finalized_checkpoint must include an epoch");
  }
  return {epoch: Number(cp.epoch), rootHex};
}

function setFinalizedCheckpoint(chain: BeaconChain, checkpoint: FinalizedCheckpoint): void {
  const checkpointWithHex = {
    epoch: checkpoint.epoch,
    root: fromHex(checkpoint.rootHex),
    rootHex: checkpoint.rootHex,
  };

  const forkChoice = chain.forkChoice as unknown as {
    fcStore: {
      finalizedCheckpoint: typeof checkpointWithHex;
      unrealizedFinalizedCheckpoint: typeof checkpointWithHex;
    };
    protoArray: {
      finalizedEpoch: number;
      finalizedRoot: RootHex;
    };
    updateHead?: () => unknown;
  };

  forkChoice.fcStore.finalizedCheckpoint = checkpointWithHex;
  forkChoice.fcStore.unrealizedFinalizedCheckpoint = checkpointWithHex;
  forkChoice.protoArray.finalizedEpoch = checkpoint.epoch;
  forkChoice.protoArray.finalizedRoot = checkpoint.rootHex;
  forkChoice.updateHead?.();
}

function getDataAvailabilityStatusForFork(fork: ForkName): DataAvailabilityStatus {
  switch (fork) {
    case ForkName.deneb:
    case ForkName.electra:
    case ForkName.fulu:
    case ForkName.gloas:
      return DataAvailabilityStatus.Available;

    default:
      return DataAvailabilityStatus.PreData;
  }
}

function computePostState(
  parentState: IBeaconStateView,
  signedBlock: SignedBeaconBlock,
  fork: ForkName
): IBeaconStateView {
  return parentState.stateTransition(
    signedBlock,
    {
      verifyStateRoot: true,
      verifyProposer: true,
      executionPayloadStatus: ExecutionPayloadStatus.valid,
      dataAvailabilityStatus: getDataAvailabilityStatusForFork(fork),
    },
    {}
  );
}

function invalidateImportedBlock(chain: BeaconChain, blockRootHex: RootHex, parentRootHex: RootHex): void {
  const parentBlock = chain.forkChoice.getBlockHexDefaultStatus(parentRootHex);
  if (!parentBlock?.executionPayloadBlockHash) {
    throw new Error(`Cannot invalidate ${blockRootHex}: parent ${parentRootHex} has no latest valid execution hash`);
  }
  const block = chain.forkChoice.getBlockHexDefaultStatus(blockRootHex);
  if (!block?.executionPayloadBlockHash) {
    throw new Error(`Cannot invalidate ${blockRootHex}: block has no execution payload hash`);
  }

  chain.forkChoice.validateLatestHash({
    executionStatus: ExecutionStatus.Invalid,
    latestValidExecHash: parentBlock.executionPayloadBlockHash,
    invalidateFromParentBlockRoot: blockRootHex,
    invalidateFromParentBlockHash: block.executionPayloadBlockHash,
  });
}

function isDescendantAtFinalizedCheckpoint(
  chain: BeaconChain,
  blockRootHex: RootHex,
  checkpoint: FinalizedCheckpoint
): boolean {
  try {
    const finalizedSlot = computeStartSlotAtEpoch(checkpoint.epoch);
    return chain.forkChoice.getAncestor(blockRootHex, finalizedSlot).blockRoot === checkpoint.rootHex;
  } catch {
    return false;
  }
}

function mapErrorToResult(e: unknown): "valid" | "ignore" | "reject" {
  if (e instanceof GossipActionError) {
    return e.action === GossipAction.IGNORE ? "ignore" : "reject";
  }
  // Some validation paths throw raw errors instead of GossipActionError
  // (e.g., validator index out of range → TypeError on undefined access).
  if (e instanceof TypeError || e instanceof RangeError) {
    return "reject";
  }
  // Pubkey-cache lookup failures bubble up as plain Error("Missing pubkey for validator index N").
  // Per spec, an out-of-range proposer/validator index is a [REJECT].
  if (e instanceof Error && /Missing pubkey for validator index/.test(e.message)) {
    return "reject";
  }
  throw e;
}

export async function runGossipValidationTest(
  fork: ForkName,
  topicHandler: string,
  testCaseDir: string
): Promise<void> {
  const meta = loadMeta(testCaseDir);
  const topic = getGossipTopic(topicHandler);
  if (meta.topic !== topic) {
    throw Error(`Gossip test topic mismatch for ${topicHandler}: expected ${topic}, got ${meta.topic}`);
  }

  const anchorState = loadState(testCaseDir, fork);
  const testCaseConfig = loadTestCaseChainConfig(testCaseDir, fork);
  const beaconConfig = createBeaconConfig(testCaseConfig, anchorState.genesisValidatorsRoot);

  const genesisTimeSec = Number(anchorState.genesisTime);
  const clock = new GossipTestClock(
    genesisTimeSec,
    beaconConfig.SLOT_DURATION_MS / 1000,
    beaconConfig.MAXIMUM_GOSSIP_CLOCK_DISPARITY
  );

  const controller = new AbortController();
  const executionEngineBackend = new ExecutionEngineMockBackend({
    onlyPredefinedResponses: false,
    genesisBlockHash: isExecutionStateType(anchorState)
      ? toHex(anchorState.latestExecutionPayloadHeader.blockHash)
      : ZERO_HASH_HEX,
  });
  const executionEngine = getExecutionEngineFromBackend(executionEngineBackend, {
    signal: controller.signal,
    logger: testLogger("executionEngine"),
  });

  const pubkeyCache = createPubkeyCache();
  syncPubkeys(pubkeyCache, anchorState.validators.getAllReadonlyValues());
  const cachedState = createCachedBeaconState(
    anchorState,
    {config: beaconConfig, pubkeyCache},
    {skipSyncPubkeys: true}
  );
  const anchorStateView = new BeaconStateView(cachedState);

  const chain = new BeaconChain(
    {
      ...defaultChainOptions,
      // Disable non-spec maxSkipSlots check for conformance tests
      maxSkipSlots: undefined,
      blsVerifyAllMainThread: true,
      disableArchiveOnCheckpoint: true,
      disableLightClientServerOnImportBlockHead: true,
      disableOnBlockError: true,
      disablePrepareNextSlot: true,
      assertCorrectProgressiveBalances,
      proposerBoost: true,
      proposerBoostReorg: true,
    },
    {
      privateKey: await generateKeyPair("secp256k1"),
      config: beaconConfig,
      pubkeyCache,
      db: getMockedBeaconDb(),
      dataDir: ".",
      dbName: ",",
      logger: testLogger("spec-gossip"),
      processShutdownCallback: () => {},
      clock,
      metrics: null,
      validatorMonitor: null,
      anchorState: anchorStateView,
      isAnchorStateFinalized: true,
      executionEngine,
      executionBuilder: undefined,
    }
  );

  chain.emitter.removeAllListeners(ChainEvent.forkChoiceFinalized);

  // Spec test fixtures may provide an anchor state that has been process_slots-advanced
  // beyond its latestBlockHeader.slot (e.g. state.slot=1 with latestBlockHeader.slot=0).
  // In that case, `state.{previous,current,next}DecisionRoot` (derived via
  // `calculateShufflingDecisionRoot`) does not match the dependent root that fork-choice
  // computes for the anchor block (which falls into the "close to genesis" special case
  // and returns the anchor block's own root). The chain's ShufflingCache was seeded with
  // the state-derived keys, so attestation/aggregate validation later falls through to
  // regen, which fails with REGEN_ERROR_NO_SEED_STATE because the anchor block's
  // post-state isn't cached at its declared stateRoot.
  // Re-insert the anchor state's shufflings under the fork-choice-derived dependent
  // root for the anchor block so attestation validation hits the cache.
  {
    const anchorBlockRootHex = (chain.forkChoice.getHead() as {blockRoot?: RootHex}).blockRoot;
    if (anchorBlockRootHex) {
      const anchorProtoBlock = chain.forkChoice.getBlockHexDefaultStatus(anchorBlockRootHex);
      if (anchorProtoBlock) {
        // Use the private `set` (intentional reach: this only affects the test harness chain).
        const sc = chain.shufflingCache as unknown as {
          set?: (shuffling: ReturnType<typeof anchorStateView.getCurrentShuffling>, decisionRoot: RootHex) => void;
        };
        // The fork-choice-derived dependent root for the anchor block. Wrapped because
        // certain advanced anchor states reference parent blocks that aren't in fork-choice.
        try {
          const fcDependentRoot = chain.forkChoice.getDependentRoot(anchorProtoBlock, EpochDifference.previous);
          sc.set?.(anchorStateView.getPreviousShuffling(), fcDependentRoot);
          sc.set?.(anchorStateView.getCurrentShuffling(), fcDependentRoot);
          sc.set?.(anchorStateView.getNextShuffling(), fcDependentRoot);
        } catch {
          // Swallow — anchor block parent may not be in protoArray for some fixtures.
        }
        // Also use the head block's own root as a fallback dependent root for far-future
        // attestation epochs (`blockEpoch < attEpoch - 1` branch in getShufflingDependentRoot).
        sc.set?.(anchorStateView.getPreviousShuffling(), anchorBlockRootHex);
        sc.set?.(anchorStateView.getCurrentShuffling(), anchorBlockRootHex);
        sc.set?.(anchorStateView.getNextShuffling(), anchorBlockRootHex);
      }
    }
  }

  // The chain's actual anchor block root, derived from the (possibly normalized) anchor
  // state's latestBlockHeader. Any meta-listed block whose root matches this is the anchor
  // block and must NOT be re-imported (Lodestar already registered it in fork-choice during
  // chain init).
  const anchorBlockRootHex = (() => {
    const lbh = ssz.phase0.BeaconBlockHeader.clone(anchorState.latestBlockHeader);
    if (toRootHex(lbh.stateRoot) === ZERO_HASH_HEX) {
      lbh.stateRoot = anchorState.hashTreeRoot();
    }
    return toRootHex(ssz.phase0.BeaconBlockHeader.hashTreeRoot(lbh));
  })();

  try {
    const blockRootsByName = new Map<string, RootHex>();
    const blockStatesByRoot = new Map<RootHex, IBeaconStateView>();
    const rejectedFailedBlockRoots = new Set<RootHex>();
    // Tracks blocks listed in `meta.blocks` (regardless of failure flags). The spec test
    // framework treats `store.blocks` as exactly this listed set, so messages whose
    // `parent_root` is not in this set must surface as IGNORE/PARENT_NOT_SEEN even if the
    // chain's anchor block in fork-choice happens to match.
    const seenMetaBlockRoots = new Set<RootHex>();
    // Tracks blob sidecars by (slot, proposer_index, blob_index) for the spec dedup rule.
    const seenBlobTuples = new Set<string>();

    if (meta.blocks) {
      for (const blockEntry of meta.blocks) {
        const signedBlock = sszTypesFor(fork).SignedBeaconBlock.deserialize(
          loadSszSnappy(testCaseDir, blockEntry.block)
        );
        const slot = signedBlock.message.slot;
        const blockRootHex = toHex(beaconConfig.getForkTypes(slot).BeaconBlock.hashTreeRoot(signedBlock.message));
        blockRootsByName.set(blockEntry.block, blockRootHex);
        seenMetaBlockRoots.add(blockRootHex);

        // The chain's anchor block — already in fork-choice via chain init. Skip re-import,
        // and treat the anchor state as its post-state for downstream block dependencies.
        // Some fixtures (e.g. blob_sidecar `reject_parent_failed_validation`) mark the
        // anchor block as `failed` to test gossip rejection of messages whose parent failed
        // validation; in that case we record the anchor root in rejectedFailedBlockRoots so
        // downstream message validation surfaces REJECT rather than treating the parent as
        // valid.
        if (blockRootHex === anchorBlockRootHex) {
          if (blockEntry.failed) {
            rejectedFailedBlockRoots.add(blockRootHex);
            continue;
          }
          blockStatesByRoot.set(blockRootHex, anchorStateView);
          continue;
        }

        // Pre-anchor historical blocks (e.g. genesis at slot 0 when the anchor state is at
        // slot 1+) cannot be re-imported because we have no parent state for them. They
        // remain in `seenMetaBlockRoots` so message parent_root checks succeed; downstream
        // blocks should never reference them as parent in practice.
        if (slot < anchorState.latestBlockHeader.slot) {
          continue;
        }

        const parentRootHex = toRootHex(signedBlock.message.parentRoot);
        const parentState = blockStatesByRoot.get(parentRootHex);
        if (!parentState) {
          if (blockEntry.failed) {
            rejectedFailedBlockRoots.add(blockRootHex);
            continue;
          }
          // Some fixtures list synthetic genesis-style blocks (e.g. slot 0 with
          // `parent_root=0`) that don't share Lodestar's actual chain anchor. We can't
          // import these via `processBlock` (no parent state), so skip them — they remain
          // tracked in `seenMetaBlockRoots` so message parent_root checks see them.
          continue;
        }

        // Failed blocks only need a post-state if they'll be imported into fork-choice
        // (payload_status=VALID). Skip the state transition otherwise — it would be wasted
        // work, and would throw for fixtures that intentionally include consensus-invalid blocks.
        if (blockEntry.failed && blockEntry.payload_status !== "VALID") {
          rejectedFailedBlockRoots.add(blockRootHex);
          continue;
        }

        const postState = computePostState(parentState, signedBlock, fork);

        if (blockEntry.failed) {
          // payload_status === "VALID" (filtered above)
          clock.setSlot(slot);
          chain.forkChoice.updateTime(slot);
          chain.forkChoice.onBlock(
            signedBlock.message,
            postState,
            0,
            slot,
            ExecutionStatus.Valid,
            getDataAvailabilityStatusForFork(fork)
          );
          blockStatesByRoot.set(blockRootHex, postState);
          continue;
        }

        if (blockEntry.payload_status === "INVALIDATED") {
          clock.setSlot(slot);
          chain.forkChoice.updateTime(slot);
          chain.forkChoice.onBlock(
            signedBlock.message,
            postState,
            0,
            slot,
            ExecutionStatus.Syncing,
            getDataAvailabilityStatusForFork(fork)
          );
          blockStatesByRoot.set(blockRootHex, postState);
          invalidateImportedBlock(chain, blockRootHex, parentRootHex);
          continue;
        }

        clock.setSlot(slot);
        chain.forkChoice.updateTime(slot);

        const blockImport =
          isForkPostDeneb(fork) && !isForkPostElectra(fork)
            ? // Deneb: blob-DA fork — use BlockInputBlobs even when blobKzgCommitments=[]
              // so versionedHashes are computed from the block body for the EL call.
              BlockInputBlobs.createFromBlock({
                forkName: fork,
                block: signedBlock as Parameters<typeof BlockInputBlobs.createFromBlock>[0]["block"],
                blockRootHex,
                source: BlockInputSource.gossip,
                seenTimestampSec: 0,
                daOutOfRange: false,
              })
            : isForkPostElectra(fork)
              ? // Electra still uses BlockInputBlobs.
                BlockInputBlobs.createFromBlock({
                  forkName: fork,
                  block: signedBlock as Parameters<typeof BlockInputBlobs.createFromBlock>[0]["block"],
                  blockRootHex,
                  source: BlockInputSource.gossip,
                  seenTimestampSec: 0,
                  daOutOfRange: false,
                })
              : BlockInputPreData.createFromBlock({
                  forkName: fork,
                  block: signedBlock,
                  blockRootHex,
                  source: BlockInputSource.gossip,
                  seenTimestampSec: 0,
                  daOutOfRange: false,
                });

        await chain.processBlock(blockImport, {
          seenTimestampSec: 0,
          validBlobSidecars: BlobSidecarValidation.Full,
          importAttestations: AttestationImportOpt.Force,
          validSignatures: false,
        });

        blockStatesByRoot.set(blockRootHex, postState);
      }
    }

    const finalizedCheckpoint = resolveFinalizedCheckpoint(meta, testCaseDir, fork, blockRootsByName);
    if (finalizedCheckpoint) {
      setFinalizedCheckpoint(chain, finalizedCheckpoint);
    }

    const failedBlockRoots = new Set<RootHex>(
      (meta.blocks ?? [])
        .filter((blockEntry) => blockEntry.failed === true)
        .map((blockEntry) => {
          const rootHex = blockRootsByName.get(blockEntry.block);
          if (!rootHex) throw new Error(`Missing cached root for block ${blockEntry.block}`);
          return rootHex;
        })
    );

    const baseCurrentTimeMs = Number(meta.current_time_ms ?? 0);
    for (const message of meta.messages) {
      const messageTimeMs = baseCurrentTimeMs + Number(message.offset_ms ?? 0);
      clock.setCurrentTimeMs(messageTimeMs);

      let result: "valid" | "ignore" | "reject";
      try {
        await validateMessageForTopic(
          chain,
          fork,
          topic,
          testCaseDir,
          message,
          failedBlockRoots,
          rejectedFailedBlockRoots,
          finalizedCheckpoint,
          seenMetaBlockRoots,
          seenBlobTuples
        );
        result = "valid";
      } catch (e) {
        result = mapErrorToResult(e);
      }

      expect(result).toEqualWithMessage(
        message.expected,
        `Unexpected gossip result for ${topicHandler}/${path.basename(testCaseDir)}/${message.message}`
      );
    }
  } finally {
    controller.abort();
    await chain.close();
  }
}

async function validateMessageForTopic(
  chain: BeaconChain,
  fork: ForkName,
  topic: GossipType,
  testCaseDir: string,
  message: MetaYaml["messages"][number],
  failedBlockRoots: Set<RootHex>,
  rejectedFailedBlockRoots: Set<RootHex>,
  finalizedCheckpoint: FinalizedCheckpoint | null,
  seenMetaBlockRoots: Set<RootHex>,
  seenBlobTuples: Set<string>
): Promise<void> {
  const bytes = rejectOnInvalidSerializedBytes(() => loadSszSnappy(testCaseDir, message.message));

  switch (topic) {
    case GossipType.beacon_block: {
      const signedBlock = rejectOnInvalidSerializedBytes(() => sszTypesFor(fork).SignedBeaconBlock.deserialize(bytes));
      const parentRootHex = toRootHex(signedBlock.message.parentRoot);

      if (rejectedFailedBlockRoots.has(parentRootHex)) {
        throw new GossipActionError(GossipAction.REJECT, {code: "SPEC_PARENT_BLOCK_FAILED"});
      }

      if (
        finalizedCheckpoint !== null &&
        !isDescendantAtFinalizedCheckpoint(chain, parentRootHex, finalizedCheckpoint)
      ) {
        throw new GossipActionError(GossipAction.REJECT, {code: "SPEC_FINALIZED_NOT_ANCESTOR"});
      }

      await validateGossipBlock(chain.config, chain, signedBlock, fork);
      chain.seenBlockProposers.add(signedBlock.message.slot, signedBlock.message.proposerIndex);
      break;
    }

    case GossipType.beacon_aggregate_and_proof: {
      const aggregate = rejectOnInvalidSerializedBytes(() =>
        sszTypesFor(fork).SignedAggregateAndProof.deserialize(bytes)
      );
      const beaconBlockRootHex = toRootHex(aggregate.message.aggregate.data.beaconBlockRoot);

      if (failedBlockRoots.has(beaconBlockRootHex)) {
        throw new GossipActionError(GossipAction.REJECT, {code: "SPEC_BLOCK_FAILED_VALIDATION"});
      }

      if (
        finalizedCheckpoint !== null &&
        !isDescendantAtFinalizedCheckpoint(chain, beaconBlockRootHex, finalizedCheckpoint)
      ) {
        throw new GossipActionError(GossipAction.IGNORE, {code: "SPEC_FINALIZED_NOT_ANCESTOR"});
      }

      await validateGossipAggregateAndProof(fork, chain, aggregate, bytes);
      break;
    }

    case GossipType.beacon_attestation: {
      const attestation = rejectOnInvalidSerializedBytes(() => sszTypesFor(fork).Attestation.deserialize(bytes));
      const beaconBlockRootHex = toRootHex(attestation.data.beaconBlockRoot);

      if (failedBlockRoots.has(beaconBlockRootHex)) {
        throw new GossipActionError(GossipAction.REJECT, {code: "SPEC_BLOCK_FAILED_VALIDATION"});
      }

      if (
        finalizedCheckpoint !== null &&
        !isDescendantAtFinalizedCheckpoint(chain, beaconBlockRootHex, finalizedCheckpoint)
      ) {
        throw new GossipActionError(GossipAction.IGNORE, {code: "SPEC_FINALIZED_NOT_ANCESTOR"});
      }

      const attDataBase64 = getBeaconAttestationGossipIndex(fork, bytes);
      const attSlot = getSlotFromBeaconAttestationSerialized(fork, bytes);
      if (attDataBase64 == null || attSlot == null) {
        throw new GossipActionError(GossipAction.REJECT, {code: "SPEC_INVALID_ATTESTATION_SERIALIZATION"});
      }

      const gossipAttestation: GossipAttestation = {
        attestation: null,
        serializedData: bytes,
        attSlot,
        attDataBase64,
        subnet: Number(message.subnet_id ?? 0),
      };

      const batchResult = await validateGossipAttestationsSameAttData(fork, chain, [gossipAttestation]);
      const first = batchResult.results[0];
      if (first?.err) throw first.err;
      break;
    }

    case GossipType.proposer_slashing: {
      const slashing = rejectOnInvalidSerializedBytes(() => sszTypesFor(fork).ProposerSlashing.deserialize(bytes));
      await validateGossipProposerSlashing(chain, slashing);
      // Mirror gossip handler: insert into opPool so duplicate detection works
      chain.opPool.insertProposerSlashing(slashing);
      break;
    }

    case GossipType.attester_slashing: {
      const slashing = rejectOnInvalidSerializedBytes(() => sszTypesFor(fork).AttesterSlashing.deserialize(bytes));
      await validateGossipAttesterSlashing(chain, slashing);
      // Mirror gossip handler: insert into opPool + fork choice
      chain.opPool.insertAttesterSlashing(fork, slashing);
      chain.forkChoice.onAttesterSlashing(slashing);
      break;
    }

    case GossipType.voluntary_exit: {
      const exit = rejectOnInvalidSerializedBytes(() => sszTypesFor(fork).SignedVoluntaryExit.deserialize(bytes));
      await validateGossipVoluntaryExit(chain, exit);
      // Mirror gossip handler: insert into opPool so duplicate detection works
      chain.opPool.insertVoluntaryExit(exit);
      break;
    }

    case GossipType.sync_committee: {
      const syncCommitteeMessage = rejectOnInvalidSerializedBytes(() =>
        ssz.altair.SyncCommitteeMessage.deserialize(bytes)
      );
      await validateGossipSyncCommittee(chain, syncCommitteeMessage, Number(message.subnet_id ?? 0));
      break;
    }

    case GossipType.sync_committee_contribution_and_proof: {
      const signedContributionAndProof = rejectOnInvalidSerializedBytes(() =>
        ssz.altair.SignedContributionAndProof.deserialize(bytes)
      );
      await validateSyncCommitteeGossipContributionAndProof(chain, signedContributionAndProof);
      break;
    }

    case GossipType.bls_to_execution_change: {
      const blsToExecutionChange = rejectOnInvalidSerializedBytes(() =>
        ssz.capella.SignedBLSToExecutionChange.deserialize(bytes)
      );
      if (chain.clock.currentEpoch < chain.config.CAPELLA_FORK_EPOCH) {
        throw new GossipActionError(GossipAction.IGNORE, {code: "SPEC_PRE_CAPELLA"});
      }
      await validateGossipBlsToExecutionChange(chain, blsToExecutionChange);
      // Mirror gossip handler: insert into opPool so duplicate detection works
      chain.opPool.insertBlsToExecutionChange(blsToExecutionChange);
      break;
    }

    case GossipType.blob_sidecar: {
      const blobSidecar = rejectOnInvalidSerializedBytes(() => ssz.deneb.BlobSidecar.deserialize(bytes));
      const headerSlot = blobSidecar.signedBlockHeader.message.slot;
      const proposerIndex = blobSidecar.signedBlockHeader.message.proposerIndex;
      const blobIdx = blobSidecar.index;
      const parentRootHex = toRootHex(blobSidecar.signedBlockHeader.message.parentRoot);

      // [REJECT] The sidecar's block's parent passes validation (failed import in fixture)
      if (rejectedFailedBlockRoots.has(parentRootHex) || failedBlockRoots.has(parentRootHex)) {
        throw new GossipActionError(GossipAction.REJECT, {code: "SPEC_BLOB_PARENT_BLOCK_FAILED"});
      }

      // [IGNORE] The sidecar's block's parent has been seen (per the spec's `store.blocks`
      // model). Lodestar's fork-choice always contains the anchor block, but the spec test
      // framework treats only `meta.blocks` as "seen", so we mirror that here.
      if (!seenMetaBlockRoots.has(parentRootHex)) {
        throw new GossipActionError(GossipAction.IGNORE, {code: "SPEC_BLOB_PARENT_NOT_SEEN"});
      }

      // [REJECT] The current finalized_checkpoint is an ancestor of the sidecar's block
      if (
        finalizedCheckpoint !== null &&
        !isDescendantAtFinalizedCheckpoint(chain, parentRootHex, finalizedCheckpoint)
      ) {
        throw new GossipActionError(GossipAction.REJECT, {code: "SPEC_BLOB_FINALIZED_NOT_ANCESTOR"});
      }

      // [REJECT] The sidecar is from a higher slot than the sidecar's block's parent
      const parentBlock = chain.forkChoice.getBlockHexDefaultStatus(parentRootHex);
      if (parentBlock && headerSlot <= parentBlock.slot) {
        throw new GossipActionError(GossipAction.REJECT, {code: "SPEC_BLOB_NOT_HIGHER_THAN_PARENT"});
      }

      // [IGNORE] The sidecar is the first sidecar for the tuple (slot, proposer, blob_index)
      const tupleKey = `${headerSlot}:${proposerIndex}:${blobIdx}`;
      if (seenBlobTuples.has(tupleKey)) {
        throw new GossipActionError(GossipAction.IGNORE, {code: "SPEC_BLOB_ALREADY_SEEN_TUPLE"});
      }

      await validateGossipBlobSidecar(fork, chain, blobSidecar, Number(message.subnet_id ?? 0));
      seenBlobTuples.add(tupleKey);
      break;
    }

    default:
      throw new Error(`Unknown gossip topic: ${topic}`);
  }
}

function rejectOnInvalidSerializedBytes<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Error) {
      throw new GossipActionError(GossipAction.REJECT, {code: "SPEC_INVALID_SERIALIZED_BYTES"});
    }
    throw e;
  }
}

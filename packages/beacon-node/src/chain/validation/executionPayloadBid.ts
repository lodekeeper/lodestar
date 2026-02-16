import {PublicKey} from "@chainsafe/blst";
import {
  CachedBeaconStateGloas,
  canBuilderCoverBid,
  createSingleSignatureSetFromComponents,
  getExecutionPayloadBidSigningRoot,
  isActiveBuilder,
} from "@lodestar/state-transition";
import {gloas} from "@lodestar/types";
import {toHex, toRootHex} from "@lodestar/utils";
import {ExecutionPayloadBidError, ExecutionPayloadBidErrorCode, GossipAction} from "../errors/index.js";
import {IBeaconChain} from "../index.js";
import {RegenCaller} from "../regen/index.js";

export async function validateApiExecutionPayloadBid(
  chain: IBeaconChain,
  signedExecutionPayloadBid: gloas.SignedExecutionPayloadBid
): Promise<void> {
  return validateExecutionPayloadBid(chain, signedExecutionPayloadBid);
}

export async function validateGossipExecutionPayloadBid(
  chain: IBeaconChain,
  signedExecutionPayloadBid: gloas.SignedExecutionPayloadBid
): Promise<void> {
  return validateExecutionPayloadBid(chain, signedExecutionPayloadBid);
}

async function validateExecutionPayloadBid(
  chain: IBeaconChain,
  signedExecutionPayloadBid: gloas.SignedExecutionPayloadBid
): Promise<void> {
  const bid = signedExecutionPayloadBid.message;
  const parentBlockRootHex = toRootHex(bid.parentBlockRoot);
  const parentBlockHashHex = toRootHex(bid.parentBlockHash);
  const state = (await chain.getHeadStateAtCurrentEpoch(
    RegenCaller.validateGossipExecutionPayloadBid
  )) as CachedBeaconStateGloas;

  // [IGNORE] `bid.slot` is the current slot or the next slot.
  const currentSlot = chain.clock.currentSlot;
  if (bid.slot !== currentSlot && bid.slot !== currentSlot + 1) {
    throw new ExecutionPayloadBidError(GossipAction.IGNORE, {
      code: ExecutionPayloadBidErrorCode.INVALID_SLOT,
      builderIndex: bid.builderIndex,
      slot: bid.slot,
    });
  }

  // [IGNORE] proposer preferences for this slot has been seen.
  const signedPreferences = chain.proposerPreferencesPool.get(bid.slot);
  if (signedPreferences === null) {
    throw new ExecutionPayloadBidError(GossipAction.IGNORE, {
      code: ExecutionPayloadBidErrorCode.PREFERENCES_NOT_SEEN,
      slot: bid.slot,
    });
  }

  // [REJECT] `bid.builder_index` is a valid/active builder index -- i.e.
  // `is_active_builder(state, bid.builder_index)` returns `True`.
  const builder = state.builders.getReadonly(bid.builderIndex);
  if (!isActiveBuilder(builder, state.finalizedCheckpoint.epoch)) {
    throw new ExecutionPayloadBidError(GossipAction.REJECT, {
      code: ExecutionPayloadBidErrorCode.BUILDER_NOT_ELIGIBLE,
      builderIndex: bid.builderIndex,
    });
  }

  // [REJECT] `bid.execution_payment` is zero.
  if (bid.executionPayment !== 0) {
    throw new ExecutionPayloadBidError(GossipAction.REJECT, {
      code: ExecutionPayloadBidErrorCode.NON_ZERO_EXECUTION_PAYMENT,
      builderIndex: bid.builderIndex,
      executionPayment: bid.executionPayment,
    });
  }

  // [REJECT] bid fee recipient and gas limit must match proposer preferences.
  const preferences = signedPreferences.message;
  if (toHex(bid.feeRecipient) !== toHex(preferences.feeRecipient) || bid.gasLimit !== BigInt(preferences.gasLimit)) {
    throw new ExecutionPayloadBidError(GossipAction.REJECT, {
      code: ExecutionPayloadBidErrorCode.PREFERENCES_MISMATCH,
      slot: bid.slot,
      bidFeeRecipient: toHex(bid.feeRecipient),
      expectedFeeRecipient: toHex(preferences.feeRecipient),
      bidGasLimit: bid.gasLimit,
      expectedGasLimit: preferences.gasLimit,
    });
  }

  // [IGNORE] this is the first signed bid seen with a valid signature from the given builder for this slot.
  if (chain.seenExecutionPayloadBids.isKnown(bid.slot, bid.builderIndex)) {
    throw new ExecutionPayloadBidError(GossipAction.IGNORE, {
      code: ExecutionPayloadBidErrorCode.BID_ALREADY_KNOWN,
      builderIndex: bid.builderIndex,
      slot: bid.slot,
      parentBlockRoot: parentBlockRootHex,
      parentBlockHash: parentBlockHashHex,
    });
  }

  // [IGNORE] this bid is the highest value bid seen for the corresponding slot
  // and the given parent block hash.
  const bestBid = chain.executionPayloadBidPool.getBestBid(parentBlockRootHex, parentBlockHashHex, bid.slot);
  if (bestBid !== null && bestBid.value >= bid.value) {
    throw new ExecutionPayloadBidError(GossipAction.IGNORE, {
      code: ExecutionPayloadBidErrorCode.BID_TOO_LOW,
      bidValue: bid.value,
      currentHighestBid: bestBid.value,
    });
  }
  // [IGNORE] `bid.value` is less or equal than the builder's excess balance --
  // i.e. `can_builder_cover_bid(state, builder_index, amount)` returns `True`.
  if (!canBuilderCoverBid(state, bid.builderIndex, bid.value)) {
    throw new ExecutionPayloadBidError(GossipAction.IGNORE, {
      code: ExecutionPayloadBidErrorCode.BID_TOO_HIGH,
      bidValue: bid.value,
      builderBalance: builder.balance,
    });
  }

  // [IGNORE] `bid.parent_block_hash` is the block hash of a known execution
  // payload in fork choice.
  // TODO GLOAS: implement this

  // [IGNORE] `bid.parent_block_root` is the hash tree root of a known beacon
  // block in fork choice.
  const block = chain.forkChoice.getBlock(bid.parentBlockRoot);
  if (block === null) {
    throw new ExecutionPayloadBidError(GossipAction.IGNORE, {
      code: ExecutionPayloadBidErrorCode.UNKNOWN_BLOCK_ROOT,
      parentBlockRoot: parentBlockRootHex,
    });
  }

  // [REJECT] `signed_execution_payload_bid.signature` is valid with respect to the `bid.builder_index`.
  const signatureSet = createSingleSignatureSetFromComponents(
    PublicKey.fromBytes(builder.pubkey),
    getExecutionPayloadBidSigningRoot(chain.config, state.slot, bid),
    signedExecutionPayloadBid.signature
  );

  if (!(await chain.bls.verifySignatureSets([signatureSet]))) {
    throw new ExecutionPayloadBidError(GossipAction.REJECT, {
      code: ExecutionPayloadBidErrorCode.INVALID_SIGNATURE,
      builderIndex: bid.builderIndex,
      slot: bid.slot,
    });
  }

  // Valid
  chain.seenExecutionPayloadBids.add(bid.slot, bid.builderIndex);
}

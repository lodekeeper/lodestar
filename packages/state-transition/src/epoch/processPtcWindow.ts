import {MIN_SEED_LOOKAHEAD, SLOTS_PER_EPOCH} from "@lodestar/params";
import {ssz} from "@lodestar/types";
import {CachedBeaconStateGloas, EpochTransitionCache} from "../types.js";
import {computePayloadTimelinessCommitteesForEpoch} from "../util/seed.js";

/**
 * This function updates the `ptc_window` field in the beacon state
 * by shifting out PTC assignments from the earliest epoch and appending new
 * PTC assignments for the latest epoch. With `MIN_SEED_LOOKAHEAD` set to `1`,
 * this means that at the start of epoch `N`, the PTC for epoch
 * `N+1` will be computed and included in the beacon state's ptc window.
 */
export function processPtcWindow(state: CachedBeaconStateGloas, cache: EpochTransitionCache): void {
  const windowSize = state.ptcWindow.length;

  // Shift out PTC assignments in the first epoch, keep remaining
  const remaining: number[][] = [];
  for (let i = SLOTS_PER_EPOCH; i < windowSize; i++) {
    remaining.push(state.ptcWindow.get(i).getAll());
  }

  // Fill in the last epoch with new PTC assignments
  const epoch = state.epochCtx.epoch + MIN_SEED_LOOKAHEAD + 1;

  // Reuse the shuffling already computed by processProposerLookahead
  const shuffling = cache.nextShuffling;
  if (shuffling == null) {
    throw new Error("nextShuffling must be computed by processProposerLookahead before processPtcWindow");
  }

  const lastEpochPtcs = computePayloadTimelinessCommitteesForEpoch(
    state,
    epoch,
    shuffling.committees,
    state.epochCtx.effectiveBalanceIncrements
  );

  // Convert Uint32Array[] to number[][] for SSZ serialization
  const lastEpochAsNumbers = lastEpochPtcs.map((ptc) => Array.from(ptc));

  state.ptcWindow = ssz.gloas.PtcWindow.toViewDU([...remaining, ...lastEpochAsNumbers]);
}

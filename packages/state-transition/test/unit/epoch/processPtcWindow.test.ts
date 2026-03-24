import {beforeAll, describe, expect, it} from "vitest";
import {createBeaconConfig} from "@lodestar/config";
import {getConfig} from "@lodestar/config/test-utils";
import {
  FAR_FUTURE_EPOCH,
  ForkName,
  MAX_EFFECTIVE_BALANCE,
  MIN_SEED_LOOKAHEAD,
  PTC_SIZE,
  SLOTS_PER_EPOCH,
} from "@lodestar/params";
import {ssz} from "@lodestar/types";
import {EpochTransitionCache} from "../../../src/cache/epochTransitionCache.js";
import {processPtcWindow} from "../../../src/epoch/processPtcWindow.js";
import {CachedBeaconStateGloas, createCachedBeaconState, createPubkeyCache} from "../../../src/index.js";
import {computeEpochShuffling} from "../../../src/util/epochShuffling.js";
import {generateState} from "../../utils/state.js";
import {generateValidators} from "../../utils/validator.js";

describe("processPtcWindow", () => {
  const windowSize = (2 + MIN_SEED_LOOKAHEAD) * SLOTS_PER_EPOCH;
  let state: CachedBeaconStateGloas;

  beforeAll(() => {
    const config = getConfig(ForkName.gloas);
    // Need enough active validators for non-empty committees in all slots
    // Use correct keys for generateValidators: activation, exit, balance, withdrawableEpoch
    const numValidators = 64;
    const validators = generateValidators(numValidators, {
      activation: 0,
      exit: FAR_FUTURE_EPOCH,
      balance: MAX_EFFECTIVE_BALANCE,
      withdrawableEpoch: FAR_FUTURE_EPOCH,
    });
    const rawState = generateState(
      {
        slot: SLOTS_PER_EPOCH,
        validators,
        balances: Array.from({length: numValidators}, () => MAX_EFFECTIVE_BALANCE),
      },
      config
    );
    state = createCachedBeaconState(rawState, {
      config: createBeaconConfig(config, rawState.genesisValidatorsRoot),
      pubkeyCache: createPubkeyCache(),
    }) as CachedBeaconStateGloas;
  });

  it("should shift window left and fill last epoch", () => {
    // Create a ptcWindow with known values:
    // Each slot's PTC is filled with (slotIndex * 100 + memberIndex) for easy identification
    const initialWindow: number[][] = [];
    for (let slot = 0; slot < windowSize; slot++) {
      const ptc: number[] = [];
      for (let j = 0; j < PTC_SIZE; j++) {
        ptc.push(slot * 100 + j);
      }
      initialWindow.push(ptc);
    }
    state.ptcWindow = ssz.gloas.PtcWindow.toViewDU(initialWindow);

    // Compute the nextShuffling needed by processPtcWindow
    const epoch = state.epochCtx.epoch + MIN_SEED_LOOKAHEAD + 1;
    const nextShuffling = computeEpochShuffling(state, state.epochCtx.currentShuffling.activeIndices, epoch);

    // Create a minimal cache with nextShuffling
    const cache = {nextShuffling} as EpochTransitionCache;

    // Run processPtcWindow
    processPtcWindow(state, cache);

    // Verify the shift: the old window[SLOTS_PER_EPOCH..] should now be at window[0..]
    const newWindow = state.ptcWindow;
    for (let slot = 0; slot < windowSize - SLOTS_PER_EPOCH; slot++) {
      const expected = initialWindow[slot + SLOTS_PER_EPOCH];
      const actual = newWindow.get(slot).getAll();
      expect(actual).toEqual(expected);
    }

    // Verify the fill: last SLOTS_PER_EPOCH entries should be newly computed
    for (let slot = windowSize - SLOTS_PER_EPOCH; slot < windowSize; slot++) {
      const ptc = newWindow.get(slot).getAll();
      expect(ptc).toHaveLength(PTC_SIZE);
      // Verify it differs from the old pattern (which had values like slot*100+j)
      const oldValue = initialWindow[slot];
      const isDifferent = ptc.some((v: number, i: number) => v !== oldValue[i]);
      expect(isDifferent).toBe(true);
    }
  });

  it("should produce window of correct size", () => {
    // Initialize with default (zeros)
    state.ptcWindow = ssz.gloas.PtcWindow.defaultViewDU();

    const epoch = state.epochCtx.epoch + MIN_SEED_LOOKAHEAD + 1;
    const nextShuffling = computeEpochShuffling(state, state.epochCtx.currentShuffling.activeIndices, epoch);
    const cache = {nextShuffling} as EpochTransitionCache;

    processPtcWindow(state, cache);

    // Window should still be the correct size
    expect(state.ptcWindow.length).toBe(windowSize);
  });
});

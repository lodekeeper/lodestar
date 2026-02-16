import {describe, expect, it} from "vitest";
import {SLOTS_PER_EPOCH} from "@lodestar/params";
import {ssz} from "@lodestar/types";
import {ProposerPreferencesPool} from "../../../../src/chain/opPools/proposerPreferencesPool.js";
import {InsertOutcome} from "../../../../src/chain/opPools/types.js";

describe("chain / opPools / ProposerPreferencesPool", () => {
  it("stores first preference for a slot", () => {
    const pool = new ProposerPreferencesPool();
    const signed = ssz.gloas.SignedProposerPreferences.defaultValue();
    signed.message.proposalSlot = 64;
    signed.message.validatorIndex = 5;

    expect(pool.add(signed)).toBe(InsertOutcome.NewData);
    expect(pool.add(signed)).toBe(InsertOutcome.AlreadyKnown);
    expect(pool.get(64)).toEqual(signed);
    expect(pool.getAll({slot: 64})).toEqual([signed]);
  });

  it("prunes old slots", () => {
    const pool = new ProposerPreferencesPool();
    const currentSlot = SLOTS_PER_EPOCH * 3;
    for (let i = 0; i <= currentSlot; i++) {
      const signed = ssz.gloas.SignedProposerPreferences.defaultValue();
      signed.message.proposalSlot = i;
      signed.message.validatorIndex = i;
      pool.add(signed);
    }

    pool.prune(currentSlot);

    expect(pool.get(0)).toBeNull();
    expect(pool.get(currentSlot)).not.toBeNull();
  });
});

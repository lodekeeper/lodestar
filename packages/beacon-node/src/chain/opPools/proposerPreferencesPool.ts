import {SLOTS_PER_EPOCH} from "@lodestar/params";
import {Slot, gloas} from "@lodestar/types";
import {InsertOutcome} from "./types.js";
import {pruneBySlot} from "./utils.js";

const SLOTS_RETAINED = SLOTS_PER_EPOCH * 2;

type GetAllOpts = {
  slot?: Slot;
};

/**
 * Store proposer preferences by proposal slot.
 */
export class ProposerPreferencesPool {
  private readonly signedPreferencesBySlot = new Map<Slot, gloas.SignedProposerPreferences>();
  private lowestPermissibleSlot = 0;

  get size(): number {
    return this.signedPreferencesBySlot.size;
  }

  add(signedPreferences: gloas.SignedProposerPreferences): InsertOutcome {
    const proposalSlot = signedPreferences.message.proposalSlot;
    if (proposalSlot < this.lowestPermissibleSlot) {
      return InsertOutcome.Old;
    }

    if (this.signedPreferencesBySlot.has(proposalSlot)) {
      return InsertOutcome.AlreadyKnown;
    }

    this.signedPreferencesBySlot.set(proposalSlot, signedPreferences);
    return InsertOutcome.NewData;
  }

  get(slot: Slot): gloas.SignedProposerPreferences | null {
    return this.signedPreferencesBySlot.get(slot) ?? null;
  }

  getAll(opts?: GetAllOpts): gloas.SignedProposerPreferences[] {
    if (opts?.slot !== undefined) {
      const preference = this.get(opts.slot);
      return preference ? [preference] : [];
    }

    return Array.from(this.signedPreferencesBySlot.values());
  }

  prune(clockSlot: Slot): void {
    this.lowestPermissibleSlot = pruneBySlot(this.signedPreferencesBySlot, clockSlot, SLOTS_RETAINED);
  }
}

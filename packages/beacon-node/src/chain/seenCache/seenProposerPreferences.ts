import {SLOTS_PER_EPOCH} from "@lodestar/params";
import {Slot, ValidatorIndex} from "@lodestar/types";
import {MapDef} from "@lodestar/utils";

const SLOTS_RETAINED = SLOTS_PER_EPOCH * 2;

/**
 * Tracks proposer preferences seen per (proposal slot, validator index).
 */
export class SeenProposerPreferences {
  private readonly validatorIndexesBySlot = new MapDef<Slot, Set<ValidatorIndex>>(() => new Set<ValidatorIndex>());
  private lowestPermissibleSlot: Slot = 0;

  isKnown(slot: Slot, validatorIndex: ValidatorIndex): boolean {
    return this.validatorIndexesBySlot.get(slot)?.has(validatorIndex) === true;
  }

  add(slot: Slot, validatorIndex: ValidatorIndex): void {
    if (slot < this.lowestPermissibleSlot) {
      throw Error(`slot ${slot} < lowestPermissibleSlot ${this.lowestPermissibleSlot}`);
    }
    this.validatorIndexesBySlot.getOrDefault(slot).add(validatorIndex);
  }

  prune(currentSlot: Slot): void {
    this.lowestPermissibleSlot = Math.max(currentSlot - SLOTS_RETAINED, 0);
    for (const slot of this.validatorIndexesBySlot.keys()) {
      if (slot < this.lowestPermissibleSlot) {
        this.validatorIndexesBySlot.delete(slot);
      }
    }
  }
}

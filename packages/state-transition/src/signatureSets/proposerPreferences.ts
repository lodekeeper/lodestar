import {BeaconConfig} from "@lodestar/config";
import {DOMAIN_PROPOSER_PREFERENCES} from "@lodestar/params";
import {Slot, gloas, ssz} from "@lodestar/types";
import {computeSigningRoot} from "../util/index.js";

export function getProposerPreferencesSigningRoot(
  config: BeaconConfig,
  _stateSlot: Slot,
  proposerPreferences: gloas.ProposerPreferences
): Uint8Array {
  // Use proposalSlot for both domain slot and message slot to ensure correct fork version
  // at the Gloas fork boundary (when validating at epoch N-1 for proposals in epoch N)
  const domain = config.getDomain(
    proposerPreferences.proposalSlot,
    DOMAIN_PROPOSER_PREFERENCES,
    proposerPreferences.proposalSlot
  );

  return computeSigningRoot(ssz.gloas.ProposerPreferences, proposerPreferences, domain);
}

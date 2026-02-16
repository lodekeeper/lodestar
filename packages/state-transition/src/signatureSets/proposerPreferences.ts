import {BeaconConfig} from "@lodestar/config";
import {DOMAIN_PROPOSER_PREFERENCES} from "@lodestar/params";
import {Slot, gloas, ssz} from "@lodestar/types";
import {computeSigningRoot} from "../util/index.js";

export function getProposerPreferencesSigningRoot(
  config: BeaconConfig,
  stateSlot: Slot,
  proposerPreferences: gloas.ProposerPreferences
): Uint8Array {
  const domain = config.getDomain(stateSlot, DOMAIN_PROPOSER_PREFERENCES, proposerPreferences.proposalSlot);

  return computeSigningRoot(ssz.gloas.ProposerPreferences, proposerPreferences, domain);
}

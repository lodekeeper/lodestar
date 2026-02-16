import {SLOTS_PER_EPOCH} from "@lodestar/params";
import {
  CachedBeaconStateGloas,
  computeEpochAtSlot,
  createSingleSignatureSetFromComponents,
  getProposerPreferencesSigningRoot,
} from "@lodestar/state-transition";
import {ValidatorIndex, gloas} from "@lodestar/types";
import {GossipAction, ProposerPreferencesError, ProposerPreferencesErrorCode} from "../errors/index.js";
import {IBeaconChain} from "../index.js";
import {RegenCaller} from "../regen/index.js";

export async function validateApiProposerPreferences(
  chain: IBeaconChain,
  signedProposerPreferences: gloas.SignedProposerPreferences
): Promise<void> {
  return validateProposerPreferences(chain, signedProposerPreferences);
}

export async function validateGossipProposerPreferences(
  chain: IBeaconChain,
  signedProposerPreferences: gloas.SignedProposerPreferences
): Promise<void> {
  return validateProposerPreferences(chain, signedProposerPreferences);
}

async function validateProposerPreferences(
  chain: IBeaconChain,
  signedProposerPreferences: gloas.SignedProposerPreferences
): Promise<void> {
  const preferences = signedProposerPreferences.message;
  const state = (await chain.getHeadStateAtCurrentEpoch(
    RegenCaller.validateGossipExecutionPayloadBid
  )) as CachedBeaconStateGloas;
  const currentEpoch = computeEpochAtSlot(state.slot);
  const proposalEpoch = computeEpochAtSlot(preferences.proposalSlot);

  // [IGNORE] preference must be for next epoch.
  if (proposalEpoch !== currentEpoch + 1) {
    throw new ProposerPreferencesError(GossipAction.IGNORE, {
      code: ProposerPreferencesErrorCode.INVALID_EPOCH,
      currentEpoch,
      proposalSlot: preferences.proposalSlot,
    });
  }

  // [REJECT] valid proposal slot according to proposer lookahead.
  const expectedValidatorIndex = getExpectedValidatorIndex(state, preferences.proposalSlot);
  if (expectedValidatorIndex !== preferences.validatorIndex) {
    throw new ProposerPreferencesError(GossipAction.REJECT, {
      code: ProposerPreferencesErrorCode.INVALID_PROPOSAL_SLOT,
      proposalSlot: preferences.proposalSlot,
      validatorIndex: preferences.validatorIndex,
      expectedValidatorIndex,
    });
  }

  // [IGNORE] first valid message per (proposal_slot, validator_index).
  if (chain.seenProposerPreferences.isKnown(preferences.proposalSlot, preferences.validatorIndex)) {
    throw new ProposerPreferencesError(GossipAction.IGNORE, {
      code: ProposerPreferencesErrorCode.PREFERENCES_ALREADY_KNOWN,
      proposalSlot: preferences.proposalSlot,
      validatorIndex: preferences.validatorIndex,
    });
  }

  // [REJECT] valid signature under DOMAIN_PROPOSER_PREFERENCES.
  const signatureSet = createSingleSignatureSetFromComponents(
    chain.index2pubkey[preferences.validatorIndex],
    getProposerPreferencesSigningRoot(chain.config, state.slot, preferences),
    signedProposerPreferences.signature
  );

  if (!(await chain.bls.verifySignatureSets([signatureSet]))) {
    throw new ProposerPreferencesError(GossipAction.REJECT, {
      code: ProposerPreferencesErrorCode.INVALID_SIGNATURE,
      proposalSlot: preferences.proposalSlot,
      validatorIndex: preferences.validatorIndex,
    });
  }
}

function getExpectedValidatorIndex(state: CachedBeaconStateGloas, proposalSlot: number): ValidatorIndex | null {
  const index = (proposalSlot % SLOTS_PER_EPOCH) + SLOTS_PER_EPOCH;
  const proposerLookahead = state.proposerLookahead.getAll();
  return proposerLookahead[index] ?? null;
}

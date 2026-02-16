import {Slot, ValidatorIndex} from "@lodestar/types";
import {GossipActionError} from "./gossipValidation.js";

export enum ProposerPreferencesErrorCode {
  INVALID_EPOCH = "PROPOSER_PREFERENCES_ERROR_INVALID_EPOCH",
  INVALID_PROPOSAL_SLOT = "PROPOSER_PREFERENCES_ERROR_INVALID_PROPOSAL_SLOT",
  PREFERENCES_ALREADY_KNOWN = "PROPOSER_PREFERENCES_ERROR_PREFERENCES_ALREADY_KNOWN",
  INVALID_SIGNATURE = "PROPOSER_PREFERENCES_ERROR_INVALID_SIGNATURE",
}

export type ProposerPreferencesErrorType =
  | {
      code: ProposerPreferencesErrorCode.INVALID_EPOCH;
      currentEpoch: number;
      proposalSlot: Slot;
    }
  | {
      code: ProposerPreferencesErrorCode.INVALID_PROPOSAL_SLOT;
      proposalSlot: Slot;
      validatorIndex: ValidatorIndex;
      expectedValidatorIndex: ValidatorIndex | null;
    }
  | {
      code: ProposerPreferencesErrorCode.PREFERENCES_ALREADY_KNOWN;
      proposalSlot: Slot;
      validatorIndex: ValidatorIndex;
    }
  | {
      code: ProposerPreferencesErrorCode.INVALID_SIGNATURE;
      proposalSlot: Slot;
      validatorIndex: ValidatorIndex;
    };

export class ProposerPreferencesError extends GossipActionError<ProposerPreferencesErrorType> {}

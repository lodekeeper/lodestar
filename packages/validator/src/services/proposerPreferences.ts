import {ApiClient, routes} from "@lodestar/api";
import {BeaconConfig} from "@lodestar/config";
import {Epoch} from "@lodestar/types";
import {fromHex, toPubkeyHex} from "@lodestar/utils";
import {Metrics} from "../metrics.js";
import {IClock, LoggerVc, batchItems} from "../util/index.js";
import {ValidatorStore} from "./validatorStore.js";

const PROPOSER_PREFERENCES_CHUNK_SIZE = 512;

export function pollProposerPreferences(
  config: BeaconConfig,
  logger: LoggerVc,
  api: ApiClient,
  clock: IClock,
  validatorStore: ValidatorStore,
  _metrics: Metrics | null
): void {
  async function publishProposerPreferences(epoch: Epoch): Promise<void> {
    if (epoch < config.GLOAS_FORK_EPOCH - 1) return;

    await validatorStore.pollValidatorIndices().catch((e: Error) => {
      logger.error("Error on pollValidatorIndices for proposer preferences", {epoch}, e);
    });

    const nextEpoch = epoch + 1;
    const res = await api.validator.getProposerDuties({epoch: nextEpoch});
    const proposerDuties = res.value();

    const signedPreferences = await Promise.all(
      proposerDuties
        .filter((duty) => validatorStore.hasVotingPubkey(toPubkeyHex(duty.pubkey)))
        .map(async (duty): Promise<routes.validator.SignedProposerPreferencesList[number]> => {
          const pubkeyHex = toPubkeyHex(duty.pubkey);
          const proposerPreferences: routes.validator.SignedProposerPreferencesList[number]["message"] = {
            proposalSlot: duty.slot,
            validatorIndex: duty.validatorIndex,
            feeRecipient: fromHex(validatorStore.getFeeRecipient(pubkeyHex)),
            gasLimit: validatorStore.getGasLimit(pubkeyHex),
          };
          return validatorStore.signProposerPreferences(pubkeyHex, proposerPreferences);
        })
    );

    const chunks = batchItems(signedPreferences, {batchSize: PROPOSER_PREFERENCES_CHUNK_SIZE});

    for (const proposerPreferences of chunks) {
      try {
        await api.validator.submitProposerPreferences({proposerPreferences});
        logger.debug("Published proposer preferences to beacon node", {epoch, count: proposerPreferences.length});
      } catch (e) {
        logger.error("Failed to publish proposer preferences to beacon node", {epoch}, e as Error);
      }
    }
  }

  clock.runEveryEpoch(publishProposerPreferences);
}

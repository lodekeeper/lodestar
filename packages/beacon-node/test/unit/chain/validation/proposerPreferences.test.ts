import {describe, expect, it, vi} from "vitest";
import {SLOTS_PER_EPOCH} from "@lodestar/params";
import {CachedBeaconStateGloas, computeStartSlotAtEpoch} from "@lodestar/state-transition";
import {ssz} from "@lodestar/types";
import {
  GossipAction,
  ProposerPreferencesError,
  ProposerPreferencesErrorCode,
} from "../../../../src/chain/errors/index.js";
import {SeenProposerPreferences} from "../../../../src/chain/seenCache/seenProposerPreferences.js";
import {validateGossipProposerPreferences} from "../../../../src/chain/validation/proposerPreferences.js";
import {getMockedBeaconChain} from "../../../mocks/mockedBeaconChain.js";

describe("chain / validation / proposerPreferences", () => {
  it("accepts valid proposer preferences", async () => {
    const chain = getMockedBeaconChain();
    const currentEpoch = 10;
    const nextEpoch = currentEpoch + 1;
    const proposalSlot = computeStartSlotAtEpoch(nextEpoch);
    const validatorIndex = 123;

    const proposerLookahead = new Array(SLOTS_PER_EPOCH * 2).fill(0);
    proposerLookahead[SLOTS_PER_EPOCH + (proposalSlot % SLOTS_PER_EPOCH)] = validatorIndex;

    chain.getHeadStateAtCurrentEpoch = vi.fn().mockResolvedValue({
      slot: computeStartSlotAtEpoch(currentEpoch),
      proposerLookahead: {getAll: () => proposerLookahead},
    } as unknown as CachedBeaconStateGloas);
    chain.seenProposerPreferences = new SeenProposerPreferences() as any;
    chain.index2pubkey[validatorIndex] = new Uint8Array(48).fill(1);
    chain.bls.verifySignatureSets = vi.fn().mockResolvedValue(true);

    const signed = ssz.gloas.SignedProposerPreferences.defaultValue();
    signed.message.proposalSlot = proposalSlot;
    signed.message.validatorIndex = validatorIndex;

    await expect(validateGossipProposerPreferences(chain, signed)).resolves.toBeUndefined();
  });

  it("rejects invalid proposer lookahead slot mapping", async () => {
    const chain = getMockedBeaconChain();
    const currentEpoch = 3;
    const proposalSlot = computeStartSlotAtEpoch(currentEpoch + 1);

    chain.getHeadStateAtCurrentEpoch = vi.fn().mockResolvedValue({
      slot: computeStartSlotAtEpoch(currentEpoch),
      proposerLookahead: {getAll: () => new Array(SLOTS_PER_EPOCH * 2).fill(1)},
    } as unknown as CachedBeaconStateGloas);
    chain.seenProposerPreferences = new SeenProposerPreferences() as any;

    const signed = ssz.gloas.SignedProposerPreferences.defaultValue();
    signed.message.proposalSlot = proposalSlot;
    signed.message.validatorIndex = 2;

    await expect(validateGossipProposerPreferences(chain, signed)).rejects.toEqual(
      expect.objectContaining({
        action: GossipAction.REJECT,
        type: expect.objectContaining({code: ProposerPreferencesErrorCode.INVALID_PROPOSAL_SLOT}),
      })
    );
  });

  it("ignores duplicate proposer preferences per slot/validator", async () => {
    const chain = getMockedBeaconChain();
    const currentEpoch = 5;
    const proposalSlot = computeStartSlotAtEpoch(currentEpoch + 1);
    const validatorIndex = 8;

    const proposerLookahead = new Array(SLOTS_PER_EPOCH * 2).fill(0);
    proposerLookahead[SLOTS_PER_EPOCH + (proposalSlot % SLOTS_PER_EPOCH)] = validatorIndex;

    chain.getHeadStateAtCurrentEpoch = vi.fn().mockResolvedValue({
      slot: computeStartSlotAtEpoch(currentEpoch),
      proposerLookahead: {getAll: () => proposerLookahead},
    } as unknown as CachedBeaconStateGloas);
    chain.seenProposerPreferences = new SeenProposerPreferences() as any;
    chain.seenProposerPreferences.add(proposalSlot, validatorIndex);

    const signed = ssz.gloas.SignedProposerPreferences.defaultValue();
    signed.message.proposalSlot = proposalSlot;
    signed.message.validatorIndex = validatorIndex;

    try {
      await validateGossipProposerPreferences(chain, signed);
      throw Error("expected validation to fail");
    } catch (e) {
      expect(e).toBeInstanceOf(ProposerPreferencesError);
      expect((e as ProposerPreferencesError).action).toBe(GossipAction.IGNORE);
      expect((e as ProposerPreferencesError).type.code).toBe(ProposerPreferencesErrorCode.PREFERENCES_ALREADY_KNOWN);
    }
  });

  it("rejects invalid signature", async () => {
    const chain = getMockedBeaconChain();
    const currentEpoch = 7;
    const proposalSlot = computeStartSlotAtEpoch(currentEpoch + 1);
    const validatorIndex = 45;
    const proposerLookahead = new Array(SLOTS_PER_EPOCH * 2).fill(0);
    proposerLookahead[SLOTS_PER_EPOCH + (proposalSlot % SLOTS_PER_EPOCH)] = validatorIndex;

    chain.getHeadStateAtCurrentEpoch = vi.fn().mockResolvedValue({
      slot: computeStartSlotAtEpoch(currentEpoch),
      proposerLookahead: {getAll: () => proposerLookahead},
    } as unknown as CachedBeaconStateGloas);
    chain.seenProposerPreferences = new SeenProposerPreferences() as any;
    chain.index2pubkey[validatorIndex] = new Uint8Array(48).fill(2);
    chain.bls.verifySignatureSets = vi.fn().mockResolvedValue(false);

    const signed = ssz.gloas.SignedProposerPreferences.defaultValue();
    signed.message.proposalSlot = proposalSlot;
    signed.message.validatorIndex = validatorIndex;

    await expect(validateGossipProposerPreferences(chain, signed)).rejects.toEqual(
      expect.objectContaining({
        action: GossipAction.REJECT,
        type: expect.objectContaining({code: ProposerPreferencesErrorCode.INVALID_SIGNATURE}),
      })
    );
  });
});

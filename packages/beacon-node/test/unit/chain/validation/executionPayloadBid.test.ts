import {describe, expect, it, vi} from "vitest";
import {ssz} from "@lodestar/types";
import {ExecutionPayloadBidErrorCode, GossipAction} from "../../../../src/chain/errors/index.js";
import {validateGossipExecutionPayloadBid} from "../../../../src/chain/validation/executionPayloadBid.js";
import {getMockedBeaconChain} from "../../../mocks/mockedBeaconChain.js";

describe("chain / validation / executionPayloadBid", () => {
  it("ignores bids when proposer preferences are not seen", async () => {
    const chain = getMockedBeaconChain();
    const signedBid = ssz.gloas.SignedExecutionPayloadBid.defaultValue();
    signedBid.message.slot = 100;

    chain.clock.currentSlot = 100;
    chain.getHeadStateAtCurrentEpoch = vi.fn().mockResolvedValue({slot: 100} as any);
    chain.proposerPreferencesPool = {get: vi.fn().mockReturnValue(null)} as any;

    await expect(validateGossipExecutionPayloadBid(chain, signedBid)).rejects.toEqual(
      expect.objectContaining({
        action: GossipAction.IGNORE,
        type: expect.objectContaining({code: ExecutionPayloadBidErrorCode.PREFERENCES_NOT_SEEN}),
      })
    );
  });

  it("rejects bids with fee recipient or gas limit mismatch", async () => {
    const chain = getMockedBeaconChain();
    const signedBid = ssz.gloas.SignedExecutionPayloadBid.defaultValue();
    signedBid.message.slot = 200;
    signedBid.message.feeRecipient = new Uint8Array(20).fill(1);
    signedBid.message.gasLimit = 35n;

    const signedPreferences = ssz.gloas.SignedProposerPreferences.defaultValue();
    signedPreferences.message.proposalSlot = 200;
    signedPreferences.message.feeRecipient = new Uint8Array(20).fill(2);
    signedPreferences.message.gasLimit = 36;

    chain.clock.currentSlot = 200;
    chain.getHeadStateAtCurrentEpoch = vi.fn().mockResolvedValue({slot: 200} as any);
    chain.proposerPreferencesPool = {get: vi.fn().mockReturnValue(signedPreferences)} as any;

    await expect(validateGossipExecutionPayloadBid(chain, signedBid)).rejects.toEqual(
      expect.objectContaining({
        action: GossipAction.REJECT,
        type: expect.objectContaining({code: ExecutionPayloadBidErrorCode.PREFERENCES_MISMATCH}),
      })
    );
  });
});

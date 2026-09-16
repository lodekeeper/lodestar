import {TopicValidatorResult} from "@libp2p/gossipsub";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {ChainForkConfig} from "@lodestar/config";
import {testLogger} from "@lodestar/logger/test-utils";
import {
  AttestationError,
  AttestationErrorCode,
  GossipAction,
  GossipActionError,
  SyncCommitteeError,
  SyncCommitteeErrorCode,
  VoluntaryExitError,
  VoluntaryExitErrorCode,
} from "../../../../src/chain/errors/index.js";
import {INetworkCore} from "../../../../src/network/core/index.js";
import {
  GossipHandlerFn,
  GossipHandlers,
  GossipMessageInfo,
  GossipType,
} from "../../../../src/network/gossip/interface.js";
import {PeerAction} from "../../../../src/network/peers/index.js";
import {getGossipValidatorFn} from "../../../../src/network/processor/gossipValidatorFn.js";

describe("getGossipValidatorFn", () => {
  let core: Pick<INetworkCore, "reportPeer">;

  beforeEach(() => {
    core = {reportPeer: vi.fn()};
  });

  it("reports invalid attestation signatures as low tolerance errors", async () => {
    await runRejectedGossip({
      type: GossipType.beacon_attestation,
      error: new AttestationError(GossipAction.REJECT, {code: AttestationErrorCode.INVALID_SIGNATURE}),
    });

    expect(core.reportPeer).toHaveBeenCalledWith(
      "peer",
      PeerAction.LowToleranceError,
      AttestationErrorCode.INVALID_SIGNATURE
    );
  });

  it("reports other attestation rejects as mid tolerance errors", async () => {
    await runRejectedGossip({
      type: GossipType.beacon_aggregate_and_proof,
      error: new AttestationError(GossipAction.REJECT, {code: AttestationErrorCode.EMPTY_AGGREGATION_BITFIELD}),
    });

    expect(core.reportPeer).toHaveBeenCalledWith(
      "peer",
      PeerAction.MidToleranceError,
      AttestationErrorCode.EMPTY_AGGREGATION_BITFIELD
    );
  });

  it("reports invalid sync committee signatures as low tolerance errors", async () => {
    await runRejectedGossip({
      type: GossipType.sync_committee,
      error: new SyncCommitteeError(GossipAction.REJECT, {code: SyncCommitteeErrorCode.INVALID_SIGNATURE}),
    });

    expect(core.reportPeer).toHaveBeenCalledWith(
      "peer",
      PeerAction.LowToleranceError,
      SyncCommitteeErrorCode.INVALID_SIGNATURE
    );
  });

  it("keeps invalid voluntary exit signatures more tolerant", async () => {
    await runRejectedGossip({
      type: GossipType.voluntary_exit,
      error: new VoluntaryExitError(GossipAction.REJECT, {code: VoluntaryExitErrorCode.INVALID_SIGNATURE}),
    });

    expect(core.reportPeer).toHaveBeenCalledWith(
      "peer",
      PeerAction.MidToleranceError,
      VoluntaryExitErrorCode.INVALID_SIGNATURE
    );
  });

  async function runRejectedGossip<T extends GossipActionError<{code: string}>>({
    type,
    error,
  }: {
    type: GossipType;
    error: T;
  }): Promise<void> {
    const gossipValidatorFn = getGossipValidatorFn(
      {
        [type]: vi.fn<Parameters<GossipHandlerFn>, ReturnType<GossipHandlerFn>>().mockRejectedValue(error),
      } as unknown as GossipHandlers,
      {
        config: {} as ChainForkConfig,
        logger: testLogger(),
        metrics: null,
        core: core as INetworkCore,
      }
    );

    await expect(
      gossipValidatorFn({
        topic: {type},
        msg: {data: new Uint8Array()} as GossipMessageInfo["msg"],
        propagationSource: "peer",
        clientAgent: "agent",
        clientVersion: "version",
        seenTimestampSec: 0,
        msgSlot: null,
      } as GossipMessageInfo)
    ).resolves.toBe(TopicValidatorResult.Reject);
  }
});

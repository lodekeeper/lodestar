import {SLOTS_PER_EPOCH} from "@lodestar/params";
import {gloas} from "@lodestar/types";
import {byteArrayEquals} from "@lodestar/utils";
import {CachedBeaconStateGloas} from "../types.js";
import {computeEpochAtSlot} from "../util/epoch.js";
import {isValidIndexedPayloadAttestation} from "./isValidIndexedPayloadAttestation.js";

export function processPayloadAttestation(
  state: CachedBeaconStateGloas,
  payloadAttestation: gloas.PayloadAttestation
): void {
  const data = payloadAttestation.data;

  if (!byteArrayEquals(data.beaconBlockRoot, state.latestBlockHeader.parentRoot)) {
    throw Error("Payload attestation is referring to the wrong block");
  }

  if (data.slot + 1 !== state.slot) {
    throw Error("Payload attestation is not from previous slot");
  }

  // At epoch boundary, the PTC for the last slot of the previous epoch must be read
  // from state.previousEpochLastPtc (effective balances may have changed during epoch processing).
  // For all other slots, the epochCtx cache has the current epoch's PTCs.
  const isEpochBoundary =
    computeEpochAtSlot(data.slot) !== computeEpochAtSlot(state.slot) &&
    data.slot % SLOTS_PER_EPOCH === SLOTS_PER_EPOCH - 1;

  const ptc = isEpochBoundary
    ? new Uint32Array(state.previousEpochLastPtc.getAll())
    : state.epochCtx.getPayloadTimelinessCommittee(data.slot);

  const attestingIndices = payloadAttestation.aggregationBits.intersectValues(ptc);
  const indexedPayloadAttestation: gloas.IndexedPayloadAttestation = {
    attestingIndices: attestingIndices.sort((a, b) => a - b),
    data: payloadAttestation.data,
    signature: payloadAttestation.signature,
  };

  if (!isValidIndexedPayloadAttestation(state, indexedPayloadAttestation, true)) {
    throw Error("Invalid payload attestation");
  }
}

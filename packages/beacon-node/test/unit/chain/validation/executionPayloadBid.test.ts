import {describe, expect, it} from "vitest";
import {IForkChoice, ProtoBlock} from "@lodestar/fork-choice";
import {RootHex} from "@lodestar/types";
import {isBidCompatibleWithHead} from "../../../../src/chain/validation/executionPayloadBid.js";

describe("isBidCompatibleWithHead", () => {
  const parentBlockHash = root("04");
  const head = {
    slot: 11,
    blockRoot: root("01"),
    parentRoot: root("02"),
    executionPayloadBlockHash: root("03"),
    parentBlockHash,
  } as ProtoBlock;

  it("accepts direct-parent bids for head or next slot outside epoch boundaries", () => {
    expect(isBidCompatibleWithHead({} as IForkChoice, head, head.slot, head.parentRoot, parentBlockHash)).toBe(true);
    expect(isBidCompatibleWithHead({} as IForkChoice, head, head.slot + 1, head.parentRoot, parentBlockHash)).toBe(
      true
    );
  });

  it("rejects stale or far-ahead direct-parent bids", () => {
    expect(isBidCompatibleWithHead({} as IForkChoice, head, head.slot - 1, head.parentRoot, parentBlockHash)).toBe(
      false
    );
    expect(isBidCompatibleWithHead({} as IForkChoice, head, head.slot + 2, head.parentRoot, parentBlockHash)).toBe(
      false
    );
  });

  it("rejects direct-parent bids at epoch boundaries", () => {
    const epochBoundaryHead = {...head, slot: 31};

    expect(
      isBidCompatibleWithHead({} as IForkChoice, epochBoundaryHead, 32, epochBoundaryHead.parentRoot, parentBlockHash)
    ).toBe(false);
  });
});

function root(byte: string): RootHex {
  return `0x${byte.repeat(32)}`;
}

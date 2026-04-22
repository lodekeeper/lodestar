import {describe, expect, it, vi} from "vitest";
import type {BeaconConfig} from "@lodestar/config";
import type {ProtoBlock} from "@lodestar/fork-choice";
import type {IBeaconStateView} from "@lodestar/state-transition";
import type {Logger} from "@lodestar/utils";
import {prettyBytesShort} from "@lodestar/utils";
import type {IBeaconChain} from "../../../src/chain/index.js";
import type {INetwork} from "../../../src/network/index.js";
import {runNodeNotifier} from "../../../src/node/notifier.js";
import type {IBeaconSync} from "../../../src/sync/index.js";

const config = {ALTAIR_FORK_EPOCH: 0, BELLATRIX_FORK_EPOCH: 0, SLOT_DURATION_MS: 12_000} as BeaconConfig;
const EXECUTION_STATUS_VALID = "Valid" as Exclude<ProtoBlock["executionStatus"], "PreMerge">;
const EXECUTION_STATUS_PAYLOAD_SEPARATED = "PayloadSeparated" as Exclude<ProtoBlock["executionStatus"], "PreMerge">;
const PAYLOAD_STATUS_PENDING = 0 as ProtoBlock["payloadStatus"];
const PAYLOAD_STATUS_FULL = 2 as ProtoBlock["payloadStatus"];

describe("runNodeNotifier", () => {
  it("keeps pre-Gloas exec-block output unchanged", async () => {
    const execHash = rootHex("33");
    const headInfo = makeProtoBlock({
      executionPayloadBlockHash: execHash,
      executionPayloadNumber: 7,
      executionStatus: EXECUTION_STATUS_VALID,
    });

    const {logLine} = await runNotifierOnce(headInfo, makeHeadState("capella"));

    expect(logLine).toContain(`exec-block: valid(7 ${prettyBytesShort(execHash)})`);
    expect(logLine).not.toContain("empty-parent");
    expect(logLine).not.toContain("prev-payload:");
  });

  it("renders Gloas PayloadSeparated heads as the same pre-Gloas-shaped exec-block row", async () => {
    const anchorHash = rootHex("44");
    const headInfo = makeProtoBlock({
      executionPayloadBlockHash: anchorHash,
      executionPayloadNumber: 12,
      executionStatus: EXECUTION_STATUS_PAYLOAD_SEPARATED,
      payloadStatus: PAYLOAD_STATUS_PENDING,
      parentBlockHash: rootHex("aa"),
    });

    const {logLine} = await runNotifierOnce(headInfo, makeHeadState("gloas"));

    expect(logLine).toContain(`exec-block: valid(12 ${prettyBytesShort(anchorHash)})`);
    expect(logLine).not.toContain("payloadseparated");
    expect(logLine).not.toContain("empty-parent");
    expect(logLine).not.toContain("prev-payload:");
  });

  it("keeps Gloas FULL heads byte-identical to pre-Gloas exec-block formatting", async () => {
    const execHash = rootHex("55");
    const headInfo = makeProtoBlock({
      executionPayloadBlockHash: execHash,
      executionPayloadNumber: 13,
      executionStatus: EXECUTION_STATUS_VALID,
      payloadStatus: PAYLOAD_STATUS_FULL,
      parentBlockHash: rootHex("bb"),
    });

    const {logLine} = await runNotifierOnce(headInfo, makeHeadState("gloas"));

    expect(logLine).toContain(`exec-block: valid(13 ${prettyBytesShort(execHash)})`);
    expect(logLine).not.toContain("empty-parent");
  });
});

async function runNotifierOnce(headInfo: ProtoBlock, headState: IBeaconStateView): Promise<{logLine: string}> {
  const abortController = new AbortController();
  const logger = {
    info: vi.fn(() => abortController.abort()),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const chain = {
    clock: {currentSlot: headInfo.slot},
    executionEngine: {state: "ONLINE"},
    forkChoice: {getHead: vi.fn(() => headInfo)},
    getHeadState: vi.fn(() => headState),
    genesisTime: Math.floor(Date.now() / 1000) - 1000,
  } as unknown as IBeaconChain;

  const network = {getConnectedPeerCount: vi.fn(() => 2)} as unknown as INetwork;
  const sync = {state: "Synced"} as unknown as IBeaconSync;

  await runNodeNotifier({
    network,
    chain,
    sync,
    config,
    logger: logger as unknown as Logger,
    signal: abortController.signal,
  });

  const logLine = logger.info.mock.calls[0]?.[0];
  if (typeof logLine !== "string") throw new Error("Expected notifier to emit a log line");
  return {logLine};
}

function makeHeadState(forkName: IBeaconStateView["forkName"]): IBeaconStateView {
  return {
    forkName,
    finalizedCheckpoint: {epoch: 1, root: Buffer.alloc(32, 0xe1)},
    isExecutionStateType: true,
    isMergeTransitionComplete: true,
  } as unknown as IBeaconStateView;
}

function makeProtoBlock(overrides: Partial<ProtoBlock> = {}): ProtoBlock {
  return {
    slot: 1,
    blockRoot: rootHex("11"),
    parentRoot: rootHex("22"),
    stateRoot: rootHex("99"),
    targetRoot: rootHex("77"),
    justifiedEpoch: 0,
    finalizedEpoch: 0,
    executionPayloadBlockHash: rootHex("33"),
    executionPayloadNumber: 1,
    executionStatus: EXECUTION_STATUS_VALID,
    payloadStatus: PAYLOAD_STATUS_FULL,
    parentBlockHash: null,
    dataAvailabilityStatus: "NotRequired" as ProtoBlock["dataAvailabilityStatus"],
    ...overrides,
  } as ProtoBlock;
}

function rootHex(hexByte: string): `0x${string}` {
  return `0x${hexByte.repeat(32)}` as `0x${string}`;
}

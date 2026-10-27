import {keccak256} from "ethereum-cryptography/keccak.js";
import {digest} from "@chainsafe/as-sha256";
import {Root, gloas} from "@lodestar/types";

type RlpInput = Uint8Array | RlpInput[];

const EMPTY_OMMERS_HASH = Buffer.from("1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347", "hex");
const EMPTY_BYTES = new Uint8Array(0);
const ZERO_NONCE = new Uint8Array(8);

/**
 * Compute the execution block hash `keccak256(rlp(header))` of a gloas `ExecutionPayload`,
 * as checked by `EXECUTION_ENGINE.is_valid_block_hash`
 */
export function computeExecutionBlockHash(
  payload: gloas.ExecutionPayload,
  parentBeaconBlockRoot: Root,
  executionRequests: Uint8Array[]
): Uint8Array {
  const withdrawals = payload.withdrawals.map((withdrawal) =>
    rlpEncode([
      uintToRlpBytes(withdrawal.index),
      uintToRlpBytes(withdrawal.validatorIndex),
      withdrawal.address,
      uintToRlpBytes(withdrawal.amount),
    ])
  );

  const header: RlpInput[] = [
    payload.parentHash,
    EMPTY_OMMERS_HASH,
    payload.feeRecipient,
    payload.stateRoot,
    orderedTrieRoot(payload.transactions.toArray()),
    payload.receiptsRoot,
    payload.logsBloom,
    uintToRlpBytes(0),
    uintToRlpBytes(payload.blockNumber),
    uintToRlpBytes(payload.gasLimit),
    uintToRlpBytes(payload.gasUsed),
    uintToRlpBytes(payload.timestamp),
    payload.extraData,
    payload.prevRandao,
    ZERO_NONCE,
    uintToRlpBytes(payload.baseFeePerGas),
    orderedTrieRoot(withdrawals),
    uintToRlpBytes(payload.blobGasUsed),
    uintToRlpBytes(payload.excessBlobGas),
    parentBeaconBlockRoot,
    computeRequestsHash(executionRequests),
    keccak256(payload.blockAccessList),
    uintToRlpBytes(payload.slotNumber),
  ];

  return keccak256(rlpEncode(header));
}

/**
 * EIP-7685 requests hash, `sha256(sha256(requests_0) ++ sha256(requests_1) ++ ...)`
 */
function computeRequestsHash(requests: Uint8Array[]): Uint8Array {
  const hashes = requests.filter((request) => request.length > 1).map((request) => digest(request));
  return digest(Buffer.concat(hashes));
}

/**
 * Root of the patricia trie `rlp(index) => value`, used for the transactions and withdrawals roots
 */
function orderedTrieRoot(values: Uint8Array[]): Uint8Array {
  const entries: TrieEntry[] = [];
  for (let i = 0; i < values.length; i++) {
    // An empty value is not inserted into the trie
    if (values[i].length > 0) {
      entries.push({key: toNibbles(rlpEncode(uintToRlpBytes(i))), value: values[i]});
    }
  }

  if (entries.length === 0) {
    return keccak256(rlpEncode(EMPTY_BYTES));
  }

  return keccak256(rlpEncode(buildTrieNode(entries, 0)));
}

type TrieEntry = {key: number[]; value: Uint8Array};

function buildTrieNode(entries: TrieEntry[], depth: number): RlpInput {
  if (entries.length === 1) {
    const {key, value} = entries[0];
    return [hexPrefixEncode(key.slice(depth), true), value];
  }

  const prefixLength = commonPrefixLength(entries, depth);
  if (prefixLength > 0) {
    return [
      hexPrefixEncode(entries[0].key.slice(depth, depth + prefixLength), false),
      trieNodeRef(buildTrieNode(entries, depth + prefixLength)),
    ];
  }

  const branch: RlpInput[] = Array.from({length: 17}, () => EMPTY_BYTES);
  for (let nibble = 0; nibble < 16; nibble++) {
    const children = entries.filter((entry) => entry.key.length > depth && entry.key[depth] === nibble);
    if (children.length > 0) {
      branch[nibble] = trieNodeRef(buildTrieNode(children, depth + 1));
    }
  }
  const terminal = entries.find((entry) => entry.key.length === depth);
  if (terminal !== undefined) {
    branch[16] = terminal.value;
  }
  return branch;
}

function commonPrefixLength(entries: TrieEntry[], depth: number): number {
  const first = entries[0].key;
  let length = 0;
  while (true) {
    const index = depth + length;
    if (entries.some((entry) => entry.key.length <= index || entry.key[index] !== first[index])) {
      return length;
    }
    length++;
  }
}

/**
 * Nodes whose encoding is shorter than 32 bytes are embedded in their parent, others are referenced by hash
 */
function trieNodeRef(node: RlpInput): RlpInput {
  const encoded = rlpEncode(node);
  return encoded.length < 32 ? node : keccak256(encoded);
}

function hexPrefixEncode(nibbles: number[], isLeaf: boolean): Uint8Array {
  const flag = isLeaf ? 2 : 0;
  const isOdd = nibbles.length % 2 === 1;
  const out = new Uint8Array(Math.floor(nibbles.length / 2) + 1);
  if (isOdd) {
    out[0] = ((flag + 1) << 4) | nibbles[0];
    for (let i = 1; i < nibbles.length; i += 2) {
      out[(i + 1) / 2] = (nibbles[i] << 4) | nibbles[i + 1];
    }
  } else {
    out[0] = flag << 4;
    for (let i = 0; i < nibbles.length; i += 2) {
      out[i / 2 + 1] = (nibbles[i] << 4) | nibbles[i + 1];
    }
  }
  return out;
}

function toNibbles(bytes: Uint8Array): number[] {
  const nibbles: number[] = [];
  for (const byte of bytes) {
    nibbles.push(byte >> 4, byte & 0x0f);
  }
  return nibbles;
}

/**
 * Big-endian bytes without leading zeros, the RLP encoding of an integer
 */
function uintToRlpBytes(value: number | bigint): Uint8Array {
  let n = BigInt(value);
  const bytes: number[] = [];
  while (n > BigInt(0)) {
    bytes.unshift(Number(n & BigInt(0xff)));
    n >>= BigInt(8);
  }
  return Uint8Array.from(bytes);
}

function rlpEncode(input: RlpInput): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length === 1 && input[0] < 0x80) {
      return input;
    }
    return Buffer.concat([rlpEncodeLength(input.length, 0x80), input]);
  }
  const payload = Buffer.concat(input.map(rlpEncode));
  return Buffer.concat([rlpEncodeLength(payload.length, 0xc0), payload]);
}

function rlpEncodeLength(length: number, offset: number): Uint8Array {
  if (length < 56) {
    return Uint8Array.of(offset + length);
  }
  const lengthBytes = uintToRlpBytes(length);
  return Uint8Array.from([offset + 55 + lengthBytes.length, ...lengthBytes]);
}

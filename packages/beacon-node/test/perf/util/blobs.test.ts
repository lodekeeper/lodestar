import {bench, describe} from "@chainsafe/benchmark";
import {createChainForkConfig} from "@lodestar/config";
import {NUMBER_OF_COLUMNS} from "@lodestar/params";
import {ssz} from "@lodestar/types";
import {reconstructBlobs} from "../../../src/util/blobs.js";
import {getDataColumnSidecarsFromBlock} from "../../../src/util/dataColumns.js";
import {kzg} from "../../../src/util/kzg.js";
import {generateRandomBlob} from "../../utils/kzg.js";

describe("reconstructBlobs", () => {
  const config = createChainForkConfig({
    ALTAIR_FORK_EPOCH: 0,
    BELLATRIX_FORK_EPOCH: 0,
    CAPELLA_FORK_EPOCH: 0,
    DENEB_FORK_EPOCH: 0,
    ELECTRA_FORK_EPOCH: 0,
    FULU_FORK_EPOCH: 0,
  });

  // KZG cell reconstruction is CPU-heavy and high-variance on the shared benchmark runner, so the
  // larger blob counts trip the 3x regression gate with false positives and are slow to run. Only
  // the smallest count runs on CI; the rest run locally, and the heaviest (48/72) require an
  // explicit RUN_HEAVY_BENCHMARKS opt-in.
  const testCases: {blobCount: number; name: string; skipCI?: boolean; heavy?: boolean}[] = [
    {blobCount: 6, name: "6 blobs"},
    {blobCount: 10, name: "10 blobs", skipCI: true},
    {blobCount: 20, name: "20 blobs", skipCI: true},
    {blobCount: 48, name: "48 blobs", skipCI: true, heavy: true},
    {blobCount: 72, name: "72 blobs", skipCI: true, heavy: true},
  ].filter((tc) => {
    if (process.env.CI && tc.skipCI) return false;
    if (tc.heavy && !process.env.RUN_HEAVY_BENCHMARKS) return false;
    return true;
  });

  for (const {blobCount, name} of testCases) {
    describe(`Reconstruct blobs - ${name}`, () => {
      const blobs = Array.from({length: blobCount}, (_) => generateRandomBlob());
      const kzgCommitments = blobs.map((blob) => kzg.blobToKzgCommitment(blob));
      const cellsAndProofs = blobs.map((blob) => kzg.computeCellsAndKzgProofs(blob));

      const signedBeaconBlock = ssz.fulu.SignedBeaconBlock.defaultValue();
      signedBeaconBlock.message.body.blobKzgCommitments = kzgCommitments;

      const allSidecars = getDataColumnSidecarsFromBlock(config, signedBeaconBlock, cellsAndProofs);
      const halfSidecars = allSidecars.sort(() => Math.random() - 0.5).slice(0, NUMBER_OF_COLUMNS / 2);

      const scenarios = [
        {sidecars: allSidecars, name: "Full columns"},
        {sidecars: halfSidecars, name: "Half columns"},
      ];

      for (const {sidecars, name} of scenarios) {
        bench({
          id: `${name} - reconstruct all ${blobCount} blobs`,
          fn: async () => {
            await reconstructBlobs(sidecars);
          },
        });

        bench({
          id: `${name} - reconstruct half of the blobs out of ${blobCount}`,
          fn: async () => {
            const indices = Array.from({length: blobCount / 2}, (_, i) => i);
            await reconstructBlobs(sidecars, indices);
          },
        });

        bench({
          id: `${name} - reconstruct single blob out of ${blobCount}`,
          fn: async () => {
            await reconstructBlobs(sidecars, [0]);
          },
        });
      }
    });
  }
});

import {describe, expect, it} from "vitest";
import {createChainForkConfig, defaultChainConfig} from "@lodestar/config";
import {ForkName} from "@lodestar/params";
import {ssz} from "@lodestar/types";
import {upgradeLightClientHeader} from "../../src/spec/utils.js";

describe("upgradeLightClientHeader", () => {
  it("upgrades fulu header to eip7782 without throwing", () => {
    const config = createChainForkConfig({
      ...defaultChainConfig,
      ALTAIR_FORK_EPOCH: 0,
      BELLATRIX_FORK_EPOCH: 0,
      CAPELLA_FORK_EPOCH: 0,
      DENEB_FORK_EPOCH: 0,
      ELECTRA_FORK_EPOCH: 0,
      FULU_FORK_EPOCH: 0,
      EIP7782_FORK_EPOCH: 1,
      GLOAS_FORK_EPOCH: 2,
    });

    const header = ssz.deneb.LightClientHeader.defaultValue();
    header.beacon.slot = 1; // fulu slot with config above

    const upgraded = upgradeLightClientHeader(config, ForkName.eip7782, header);
    // EIP-7782 introduces no LightClientHeader shape change, so beacon data should be preserved
    expect(upgraded.beacon.slot).toBe(header.beacon.slot);
  });

  it("upgrades fulu header to gloas through eip7782 without throwing", () => {
    const config = createChainForkConfig({
      ...defaultChainConfig,
      ALTAIR_FORK_EPOCH: 0,
      BELLATRIX_FORK_EPOCH: 0,
      CAPELLA_FORK_EPOCH: 0,
      DENEB_FORK_EPOCH: 0,
      ELECTRA_FORK_EPOCH: 0,
      FULU_FORK_EPOCH: 0,
      EIP7782_FORK_EPOCH: 1,
      GLOAS_FORK_EPOCH: 2,
    });

    const header = ssz.deneb.LightClientHeader.defaultValue();
    header.beacon.slot = 1; // fulu slot with config above

    const upgraded = upgradeLightClientHeader(config, ForkName.gloas, header);
    expect(upgraded.beacon.slot).toBe(header.beacon.slot);
  });
});

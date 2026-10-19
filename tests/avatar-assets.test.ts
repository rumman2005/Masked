import { describe, expect, it } from "vitest";

import {
  AVATAR_ASSETS,
  AVATAR_IDS,
  DEFAULT_AVATAR_ID,
  getAvatarAsset,
} from "../src/components/avatarAssets";

describe("avatar asset registry", () => {
  it("registers every character with a local SVG source", () => {
    expect(Object.keys(AVATAR_ASSETS).sort()).toEqual([...AVATAR_IDS].sort());

    for (const avatarId of AVATAR_IDS) {
      const asset = AVATAR_ASSETS[avatarId];
      expect(asset.id).toBe(avatarId);
      expect(asset.label.length).toBeGreaterThan(0);
      expect(asset.src).toMatch(/svg/i);
      expect(asset.src).not.toMatch(/^https?:\/\//i);
    }
  });

  it("uses the default character for unknown runtime ids", () => {
    expect(getAvatarAsset("not-a-real-avatar")).toBe(AVATAR_ASSETS[DEFAULT_AVATAR_ID]);
    expect(getAvatarAsset(null)).toBe(AVATAR_ASSETS[DEFAULT_AVATAR_ID]);
  });
});

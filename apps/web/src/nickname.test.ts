import { describe, it, expect } from "vitest";
import { NICKNAME_MAX_LENGTH } from "@diffsync/protocol";
import { generateGuestNickname } from "./nickname";

describe("generateGuestNickname", () => {
  it("produces a readable two-word name with a discriminator", () => {
    expect(generateGuestNickname(() => 0)).toMatch(/^[a-z]+-[a-z]+-[0-9a-z]{3}$/u);
  });

  it("fits inside the protocol's nickname cap", () => {
    // If it did not, every guest would be truncated on the wire and two
    // guests could collide on the truncated form.
    for (let i = 0; i < 200; i += 1) {
      expect(generateGuestNickname().length).toBeLessThanOrEqual(NICKNAME_MAX_LENGTH);
    }
  });

  it("does not collide across a demo-sized room", () => {
    // Nicknames are load-bearing: presence, comment attribution and the
    // resolved-thread archive all name people by nickname. A pool small
    // enough to collide would merge two reviewers into one.
    const names = new Set(Array.from({ length: 200 }, () => generateGuestNickname()));
    expect(names.size).toBeGreaterThan(190);
  });
});

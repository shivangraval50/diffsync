import { describe, it, expect } from "vitest";
import { jwt } from "./auth";

describe("the jwt callback", () => {
  it("overwrites the token name with GitHub's unique login", async () => {
    // `profile.name` is a free-text display name two accounts can share;
    // `login` is globally unique. Presence, comment attribution and the
    // resolved-thread archive all key on nickname, so two real people sharing
    // a display name would otherwise be indistinguishable in a review.
    const token = await jwt({ token: { name: "Ada L" }, profile: { login: "ada" } });
    expect(token.name).toBe("ada");
  });

  it("leaves the token alone on a request with no profile", async () => {
    // `profile` is present only on the sign-in request; every later request
    // has just the encoded token.
    const token = await jwt({ token: { name: "ada" } });
    expect(token.name).toBe("ada");
  });
});

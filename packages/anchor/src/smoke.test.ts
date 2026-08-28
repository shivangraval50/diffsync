import { describe, it, expect } from "vitest";
import { LlmConfigError, selectProvider, type LlmProvider } from "@openbid/llm";
import { ANCHOR_FORMAT_VERSION } from "./index.js";

describe("workspace wiring", () => {
  it("exposes an anchor format version", () => {
    expect(ANCHOR_FORMAT_VERSION).toBe(1);
  });
});

describe("the vendored @openbid/llm port", () => {
  it("selects a named provider when a key is present", () => {
    const provider: LlmProvider = selectProvider({ ANTHROPIC_API_KEY: "sk-not-real" });
    expect(provider.name).toBe("anthropic");
    expect(typeof provider.complete).toBe("function");
  });

  it("throws LlmConfigError -- not a bare Error -- when nothing is configured", () => {
    // The distinction is load-bearing downstream: Task 18's route handler
    // catches LlmConfigError specifically in order to degrade silently, and
    // lets every other failure surface. A test asserting only `.toThrow()`
    // would keep passing if the class were replaced by a plain Error, which
    // is exactly the change that would break silent degradation.
    expect(() => selectProvider({})).toThrow(LlmConfigError);
  });
});

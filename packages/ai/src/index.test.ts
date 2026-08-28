import { describe, it, expect } from "vitest";
import type { CompletionRequest, LlmProvider } from "@openbid/llm";
import { parseUnifiedDiff, type PullRequest } from "@diffsync/diff";
import { buildAiInput, buildRequest, parseAiOutput, runAiPass } from "./index";

const PR: PullRequest = {
  ref: { kind: "fixture", slug: "demo", revision: 1 },
  title: "Refactor session issuance",
  author: "octo",
  headSha: "head",
  baseSha: "base",
  files: [
    {
      kind: "patch",
      path: "src/auth/session.ts",
      previousPath: null,
      blobSha: "b1",
      status: "modified",
      hunks: parseUnifiedDiff(
        [
          "@@ -1,2 +1,3 @@ createSession",
          " const a = 1;",
          "-const b = 2;",
          "+const b = 3;",
          "+const c = 4;",
        ].join("\n")
      ),
    },
    {
      kind: "omitted",
      path: "assets/logo.png",
      previousPath: null,
      blobSha: "b2",
      status: "modified",
      reason: "binary",
    },
  ],
};

// A second, unrelated pull request -- used to prove that the prompt actually
// varies with its input rather than being some fixed string `runAiPass`
// happens to produce regardless of what it is given.
const OTHER_PR: PullRequest = {
  ref: { kind: "fixture", slug: "other", revision: 1 },
  title: "Rename the widget factory",
  author: "octo",
  headSha: "head2",
  baseSha: "base2",
  files: [
    {
      kind: "patch",
      path: "src/widgets/factory.ts",
      previousPath: null,
      blobSha: "b3",
      status: "modified",
      hunks: parseUnifiedDiff(
        ["@@ -1,1 +1,1 @@ makeWidget", "-return old();", "+return fresh();"].join("\n")
      ),
    },
  ],
};

function fakeProvider(reply: string): LlmProvider {
  return { name: "fake", complete: async () => reply };
}

/**
 * A fake that records the exact request it was handed, so a test can assert
 * on what `runAiPass` actually sent -- not just that it sent something. A
 * bare `text.length > 0` assertion on the reply passes even if the wrong
 * prompt were built entirely; recording the input closes that gap.
 */
function recordingProvider(reply: string): LlmProvider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    name: "fake",
    requests,
    complete: async (request) => {
      requests.push(request);
      return reply;
    },
  };
}

const GOOD = JSON.stringify({
  summary: "Session expiry now uses a named constant and records an issue time.",
  flags: [{ path: "src/auth/session.ts", hunkIndex: 0, reason: "Changes token lifetime." }],
});

const OPTS = {
  generatedBy: "fake",
  generatedAtMs: 5,
  knownPaths: new Set(["src/auth/session.ts"]),
};

describe("buildAiInput", () => {
  it("counts added and removed lines per hunk", () => {
    expect(buildAiInput(PR).files[0]?.hunks[0]).toMatchObject({
      heading: "createSession",
      added: 2,
      removed: 1,
    });
  });

  it("omits files with no diff, which there is nothing to say about", () => {
    // Listing a binary file with no content would invite the model to invent
    // something about it, and that invention would be rendered as a flag.
    expect(buildAiInput(PR).files.map((f) => f.path)).toEqual(["src/auth/session.ts"]);
  });
});

describe("buildRequest", () => {
  it("asks for JSON and includes the pull request title", () => {
    const request = buildRequest(buildAiInput(PR));
    expect(request.prompt).toContain("Refactor session issuance");
    expect(request.system).toMatch(/json/iu);
    expect(request.maxTokens).toBeGreaterThan(0);
  });

  it("includes each changed file's path and hunk content in the prompt", () => {
    // A prompt that dropped the actual diff content and asked the model to
    // guess would still "ask for JSON" and still "include the title" -- both
    // assertions above would keep passing. This is what actually catches
    // that regression.
    const request = buildRequest(buildAiInput(PR));
    expect(request.prompt).toContain("src/auth/session.ts");
    expect(request.prompt).toContain("const b = 3;");
    expect(request.prompt).toContain("const c = 4;");
    // The omitted binary file must never appear: there is no content to
    // ground a claim about it.
    expect(request.prompt).not.toContain("assets/logo.png");
  });

  it("produces a different prompt for a different pull request", () => {
    // Guards against a `buildRequest` that ignores its argument and always
    // renders the same fixture -- a bug no single-PR assertion could catch.
    const first = buildRequest(buildAiInput(PR));
    const second = buildRequest(buildAiInput(OTHER_PR));
    expect(first.prompt).not.toEqual(second.prompt);
    expect(second.prompt).toContain("src/widgets/factory.ts");
    expect(second.prompt).toContain("return fresh();");
  });
});

describe("parseAiOutput", () => {
  it("parses a well-formed reply", () => {
    const pass = parseAiOutput(GOOD, OPTS);
    expect(pass?.summary).toMatch(/named constant/u);
    expect(pass?.flags).toHaveLength(1);
    expect(pass?.generatedBy).toBe("fake");
  });

  it("tolerates a fenced code block, which models emit constantly", () => {
    expect(parseAiOutput("```json\n" + GOOD + "\n```", OPTS)?.flags).toHaveLength(1);
  });

  it("drops a flag naming a file that is not in the pull request", () => {
    // A model naming a file nobody changed is a hallucination, and rendering
    // it beside the diff would present it as a claim about this review.
    const reply = JSON.stringify({
      summary: "Something changed.",
      flags: [
        { path: "src/not-in-this-pr.ts", hunkIndex: 0, reason: "invented" },
        { path: "src/auth/session.ts", hunkIndex: 0, reason: "real" },
      ],
    });
    const pass = parseAiOutput(reply, OPTS);
    expect(pass?.flags.map((f) => f.path)).toEqual(["src/auth/session.ts"]);
    // The summary survives: one bad flag is not a reason to lose the rest.
    expect(pass?.summary).toBe("Something changed.");
  });

  it("returns null for output that is not JSON at all", () => {
    expect(parseAiOutput("I am afraid I cannot do that.", OPTS)).toBeNull();
  });

  it("returns null for JSON of the wrong shape", () => {
    expect(parseAiOutput(JSON.stringify({ summary: 42 }), OPTS)).toBeNull();
  });

  it("returns null for an empty completion, which is what a refusal looks like", () => {
    // @openbid/llm's Anthropic adapter returns "" when the model refuses (an
    // HTTP 200 with stop_reason "refusal"). That has to degrade to no summary,
    // not to a crash or to an empty panel.
    expect(parseAiOutput("", OPTS)).toBeNull();
  });
});

describe("runAiPass", () => {
  it("returns a labelled pass naming the provider that produced it", async () => {
    const pass = await runAiPass(fakeProvider(GOOD), PR, 1_000);
    expect(pass?.generatedBy).toBe("fake");
    expect(pass?.generatedAtMs).toBe(1_000);
  });

  it("carries the fake's reply through intact, not just a truthy pass", async () => {
    // A test that only checks `pass !== null` (or that some field is
    // non-empty) would pass even if `runAiPass` parsed the wrong text, or
    // silently substituted its own summary. This pins the exact content.
    const pass = await runAiPass(fakeProvider(GOOD), PR, 1_000);
    expect(pass?.summary).toBe(
      "Session expiry now uses a named constant and records an issue time."
    );
    expect(pass?.flags).toEqual([
      { path: "src/auth/session.ts", hunkIndex: 0, reason: "Changes token lifetime." },
    ]);
  });

  it("sends the pull request's own title and hunk content to the provider", async () => {
    const provider = recordingProvider(GOOD);
    await runAiPass(provider, PR, 1_000);
    expect(provider.requests).toHaveLength(1);
    const [request] = provider.requests;
    expect(request?.prompt).toContain("Refactor session issuance");
    expect(request?.prompt).toContain("src/auth/session.ts");
    expect(request?.prompt).toContain("const b = 3;");
  });

  it("sends a different prompt for a different pull request", async () => {
    // Proves `runAiPass` is not feeding the provider some fixed prompt --
    // the same failure `buildRequest`'s equivalent test above guards
    // against, but exercised through the whole `runAiPass` path this time.
    const provider = recordingProvider(GOOD);
    await runAiPass(provider, PR, 1_000);
    const other = recordingProvider(GOOD);
    await runAiPass(other, OTHER_PR, 1_000);
    expect(provider.requests[0]?.prompt).not.toEqual(other.requests[0]?.prompt);
    expect(other.requests[0]?.prompt).toContain("src/widgets/factory.ts");
  });

  it("returns null rather than throwing when the provider fails", async () => {
    const broken: LlmProvider = {
      name: "broken",
      complete: async () => {
        throw new Error("upstream 500");
      },
    };
    // `.resolves.toBeNull()` -- not `.toThrow()` and not merely "settles" --
    // is the point: a promise that rejected would fail this same assertion,
    // so this proves the failure was caught and converted to an explicit
    // absence, not merely that nothing propagated further.
    await expect(runAiPass(broken, PR, 1_000)).resolves.toBeNull();
  });

  it("returns null when the provider returns unusable output", async () => {
    await expect(runAiPass(fakeProvider("not json"), PR, 1_000)).resolves.toBeNull();
  });
});

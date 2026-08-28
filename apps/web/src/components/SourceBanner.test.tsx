import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PullRequest } from "@diffsync/diff";
import { SourceBanner } from "./SourceBanner";

// Annotated as `PullRequest` rather than `as const`: `as const` freezes
// `files` as `readonly []`, which is not assignable to `PullRequest["files"]`
// (a mutable `FileDiff[]`) and fails `tsc` even though Vitest's esbuild
// transform never type-checks and lets the test run anyway.
const pr: PullRequest = {
  ref: { kind: "fixture", slug: "auth-refactor", revision: 1 },
  title: "t",
  author: "a",
  headSha: "h",
  baseSha: "b",
  files: [],
};

describe("SourceBanner", () => {
  it("says nothing for a real GitHub pull request", () => {
    render(<SourceBanner source={{ origin: "github", pr, fetchedAtMs: 1 }} />);
    expect(screen.queryByTestId("source-banner")).toBeNull();
  });

  it("marks a seeded sample as a sample", () => {
    render(<SourceBanner source={{ origin: "fixture", pr }} />);
    expect(screen.getByTestId("source-banner")).toHaveTextContent(/seeded sample pull request/iu);
  });

  it("explains a rate-limited fallback in terms of the shared quota", () => {
    // The exact wording is the point: "something went wrong" would leave the
    // visitor believing they are reviewing the pull request they pasted.
    render(<SourceBanner source={{ origin: "fallback", pr, reason: "rate_limited" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/quota is shared/iu);
    expect(screen.getByRole("alert")).toHaveTextContent(/sample pull request instead/iu);
  });

  it("distinguishes a pull request that does not exist from a quota problem", () => {
    render(<SourceBanner source={{ origin: "fallback", pr, reason: "not_found" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be found/iu);
    expect(screen.getByRole("alert")).not.toHaveTextContent(/quota/iu);
  });
});

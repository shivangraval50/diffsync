import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RejectBanner } from "./RejectBanner";

describe("RejectBanner", () => {
  it("shows nothing when nothing was rejected", () => {
    render(<RejectBanner reject={null} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("tells a reviewer whose diff moved to reload, in those terms", () => {
    render(<RejectBanner reject={{ clientSeq: 1, reason: "STALE_ANCHOR" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/changed under you/iu);
    expect(screen.getByRole("alert")).toHaveTextContent(/reload/iu);
  });

  it("distinguishes rate limiting from every other reason", () => {
    render(<RejectBanner reject={{ clientSeq: 1, reason: "RATE_LIMITED" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/too quickly/iu);
    expect(screen.getByRole("alert")).not.toHaveTextContent(/reload/iu);
  });

  it("has distinct wording for all four reasons", () => {
    const texts = (["RATE_LIMITED", "UNKNOWN_FILE", "UNKNOWN_THREAD", "STALE_ANCHOR"] as const).map(
      (reason) => {
        const { unmount } = render(<RejectBanner reject={{ clientSeq: 1, reason }} />);
        const text = screen.getByRole("alert").textContent ?? "";
        unmount();
        return text;
      }
    );
    expect(new Set(texts).size).toBe(4);
    expect(texts.every((t) => t.length > 0)).toBe(true);
  });
});

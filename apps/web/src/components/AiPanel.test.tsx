import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AiPass } from "@diffsync/protocol";
import { AiPanel } from "./AiPanel";

const pass: AiPass = {
  summary: "Session expiry now uses a named constant.",
  flags: [{ path: "src/auth/session.ts", hunkIndex: 0, reason: "Changes token lifetime." }],
  generatedBy: "gemini",
  generatedAtMs: 1,
};

describe("AiPanel", () => {
  it("renders nothing at all when there is no pass", () => {
    // The degradation contract: no key, no summary, and no empty box or
    // spinner implying one is on its way.
    const { container } = render(<AiPanel pass={null} />);
    expect(screen.queryByTestId("ai-panel")).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it("labels the output as coming from a model, naming which one", () => {
    render(<AiPanel pass={pass} />);
    expect(screen.getByTestId("ai-panel")).toHaveTextContent(/model output/iu);
    expect(screen.getByTestId("ai-panel")).toHaveTextContent("gemini");
  });

  it("shows the summary and each flagged hunk with its reason", () => {
    render(<AiPanel pass={pass} />);
    expect(screen.getByTestId("ai-summary")).toHaveTextContent("named constant");
    expect(screen.getByTestId("ai-flag-0")).toHaveTextContent("src/auth/session.ts");
    expect(screen.getByTestId("ai-flag-0")).toHaveTextContent("Changes token lifetime.");
  });

  it("does not call the output a finding or a review", () => {
    // The spec's rule, made checkable: this is a reading-order suggestion, not
    // an assertion about the code's correctness.
    render(<AiPanel pass={pass} />);
    const text = screen.getByTestId("ai-panel").textContent ?? "";
    expect(text).not.toMatch(/\bfindings?\b/iu);
    expect(text).not.toMatch(/\bissues? found\b/iu);
  });

  it("labels a second provider by name too, not a hardcoded 'gemini'", () => {
    // A panel that hardcoded the string "gemini" instead of reading
    // `pass.generatedBy` would still pass every assertion above.
    render(
      <AiPanel
        pass={{
          summary: "A different summary.",
          flags: [],
          generatedBy: "anthropic",
          generatedAtMs: 2,
        }}
      />
    );
    expect(screen.getByTestId("ai-panel")).toHaveTextContent("anthropic");
    expect(screen.getByTestId("ai-panel")).not.toHaveTextContent("gemini");
  });
});

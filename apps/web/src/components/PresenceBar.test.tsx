import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Presence } from "@diffsync/protocol";
import { PresenceBar } from "./PresenceBar";

const presence: Presence[] = [
  { reviewerId: "r1", nickname: "ada", persistent: false, cursor: null },
  {
    reviewerId: "r2",
    nickname: "grace",
    persistent: true,
    cursor: { filePath: "src/a.ts", line: 12 },
  },
];

describe("PresenceBar", () => {
  it("names everyone here and marks which one is you", () => {
    render(<PresenceBar presence={presence} youAre="r1" status="open" />);
    expect(screen.getByTestId("reviewer-r1")).toHaveTextContent(/ada \(you\)/iu);
    expect(screen.getByTestId("reviewer-r2")).toHaveTextContent("grace");
    expect(screen.getByTestId("reviewer-r2")).not.toHaveTextContent(/you/iu);
  });

  it("says where another reviewer is looking", () => {
    render(<PresenceBar presence={presence} youAre="r1" status="open" />);
    expect(screen.getByTestId("reviewer-r2")).toHaveTextContent("src/a.ts:12");
  });

  it("shows a connection warning only while not open", () => {
    const { rerender } = render(
      <PresenceBar presence={presence} youAre="r1" status="open" />
    );
    expect(screen.queryByRole("status")).toBeNull();

    rerender(<PresenceBar presence={presence} youAre="r1" status="reconnecting" />);
    expect(screen.getByRole("status")).toHaveTextContent(/reconnecting/iu);
  });
});

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parseUnifiedDiff, type FileDiff } from "@diffsync/diff";
import { DiffPanelHost } from "./DiffPanelHost";

const FILES: FileDiff[] = [
  {
    kind: "patch",
    path: "src/a.ts",
    previousPath: null,
    blobSha: "sha-a",
    status: "modified",
    hunks: parseUnifiedDiff("@@ -1,1 +1,1 @@\n-old\n+new"),
  },
];

describe("DiffPanelHost", () => {
  // This component exists only so `pr/[key]/page.tsx` -- an async Server
  // Component -- never has to pass a function prop to DiffPanel, which
  // React does not allow across the server/client boundary. That constraint
  // isn't something `vitest`/jsdom can observe (it never does real RSC
  // serialization); what these tests can check is that the placeholder
  // selection state it owns while Task 17's real thread wiring doesn't
  // exist yet actually flows end to end, rather than being dead plumbing.
  it("selects a line end to end when its anchor is clicked", async () => {
    render(<DiffPanelHost files={FILES} />);
    expect(screen.getByTestId("line-src/a.ts-1")).toHaveAttribute("data-selected", "false");

    await userEvent.click(screen.getByTestId("anchor-src/a.ts-1"));

    expect(screen.getByTestId("line-src/a.ts-1")).toHaveAttribute("data-selected", "true");
  });
});

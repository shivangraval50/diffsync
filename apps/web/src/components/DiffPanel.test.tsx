import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parseUnifiedDiff, type FileDiff } from "@diffsync/diff";
import { DiffPanel } from "./DiffPanel";

const FILES: FileDiff[] = [
  {
    kind: "patch",
    path: "src/a.ts",
    previousPath: null,
    blobSha: "sha-a",
    status: "modified",
    hunks: parseUnifiedDiff("@@ -1,1 +1,2 @@\n-old line\n+new line\n+extra line"),
  },
  {
    kind: "patch",
    path: "src/b.ts",
    previousPath: null,
    blobSha: "sha-b",
    status: "added",
    hunks: parseUnifiedDiff("@@ -0,0 +1,1 @@\n+brand new"),
  },
];

const NO_CURSORS = new Map<string, ReadonlyMap<number, readonly string[]>>();

describe("DiffPanel", () => {
  it("renders every file", () => {
    render(
      <DiffPanel
        files={FILES}
        selected={null}
        cursorsByLine={NO_CURSORS}
        renderBelow={() => null}
        onLineSelect={vi.fn()}
      />
    );
    expect(screen.getByTestId("line-src/a.ts-1")).toBeInTheDocument();
    expect(screen.getByTestId("line-src/b.ts-1")).toBeInTheDocument();
  });

  it("keeps a thread on the same code line when the view is toggled", async () => {
    // The whole reason the toggle exists in this project: switching the
    // layout must not move a single anchor.
    render(
      <DiffPanel
        files={FILES}
        selected={null}
        cursorsByLine={NO_CURSORS}
        renderBelow={(path, line) =>
          path === "src/a.ts" && line === 2 ? <p>thread on line 2</p> : null
        }
        onLineSelect={vi.fn()}
      />
    );

    const before = screen.getByTestId("line-src/a.ts-2");
    expect(within(before).getByText("extra line")).toBeInTheDocument();
    expect(screen.getAllByText("thread on line 2")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: /split/iu }));

    const after = screen.getByTestId("line-src/a.ts-2");
    expect(within(after).getByText("extra line")).toBeInTheDocument();
    expect(within(after).getByTestId("new-line-number")).toHaveTextContent("2");
    expect(screen.getAllByText("thread on line 2")).toHaveLength(1);
  });

  it("switches every file's layout together, not just the one that happened to be tested", async () => {
    // The toggle is one control for the whole panel. If it only flipped
    // whichever file a caller happened to check, some files would silently
    // stay in the stale layout.
    render(
      <DiffPanel
        files={FILES}
        selected={null}
        cursorsByLine={NO_CURSORS}
        renderBelow={() => null}
        onLineSelect={vi.fn()}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: /split/iu }));
    expect(screen.getByTestId("split-row-src/a.ts-0")).toBeInTheDocument();
    expect(screen.getByTestId("split-row-src/b.ts-0")).toBeInTheDocument();
  });

  it("reports both the file and the line when a gutter is clicked", async () => {
    const onLineSelect = vi.fn();
    render(
      <DiffPanel
        files={FILES}
        selected={null}
        cursorsByLine={NO_CURSORS}
        renderBelow={() => null}
        onLineSelect={onLineSelect}
      />
    );
    await userEvent.click(screen.getByTestId("anchor-src/b.ts-1"));
    expect(onLineSelect).toHaveBeenCalledWith("src/b.ts", 1);
  });

  it("scopes cursors to the file they were reported on, not to every file", () => {
    // cursorsByLine is keyed per file path. A DiffPanel that forgot to look
    // the file up (or fell back to the same map for everyone) would show a
    // reviewer's cursor on every file's line 1 instead of just one.
    const cursors = new Map<string, ReadonlyMap<number, readonly string[]>>([
      ["src/b.ts", new Map([[1, ["grace"]]])],
    ]);
    render(
      <DiffPanel
        files={FILES}
        selected={null}
        cursorsByLine={cursors}
        renderBelow={() => null}
        onLineSelect={vi.fn()}
      />
    );
    expect(screen.getByTestId("cursors-src/b.ts-1")).toHaveTextContent("grace");
    expect(screen.queryByTestId("cursors-src/a.ts-1")).toBeNull();
  });

  it("scopes the selected line to the file it belongs to, not to every file with the same line number", () => {
    // `selected` names one (path, line) pair. Before this fix, DiffPanel
    // forwarded a bare line number to every file's DiffFileView, so
    // selecting src/a.ts's line 1 also lit up src/b.ts's unrelated line 1 --
    // two different files that happen to share a line number are not the
    // same code, and a reviewer would see two rows highlighted for one click.
    render(
      <DiffPanel
        files={FILES}
        selected={{ path: "src/a.ts", line: 1 }}
        cursorsByLine={NO_CURSORS}
        renderBelow={() => null}
        onLineSelect={vi.fn()}
      />
    );
    expect(screen.getByTestId("line-src/a.ts-1")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("line-src/b.ts-1")).toHaveAttribute("data-selected", "false");
  });
});

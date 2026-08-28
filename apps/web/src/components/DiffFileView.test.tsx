import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parseUnifiedDiff, type FileDiff } from "@diffsync/diff";
import { DiffFileView } from "./DiffFileView";

const FILE: FileDiff = {
  kind: "patch",
  path: "src/total.ts",
  previousPath: null,
  blobSha: "sha-r1",
  status: "modified",
  hunks: parseUnifiedDiff(
    [
      "@@ -10,4 +10,5 @@ function total(items) {",
      "   let sum = 0;",
      "-    sum += item.price;",
      "+    sum += item.price * item.quantity;",
      "+    audit(item);",
      "   return sum;",
      " }",
    ].join("\n")
  ),
};

const NO_CURSORS = new Map<number, readonly string[]>();
const nothing = () => null;

// testing-library's default text matchers (getByText, toHaveTextContent)
// normalize whitespace -- trimming and collapsing runs of spaces -- before
// comparing. That is fine for prose, but a code line's leading indentation
// is real content a reviewer needs to read correctly, and several of these
// fixture lines carry four leading spaces. Reading the <code> element's
// textContent directly and comparing with `toBe` sidesteps the normalizer
// entirely, so these assertions check the exact text that was rendered.
function codeText(scope: HTMLElement): string | null {
  return scope.querySelector("code")?.textContent ?? null;
}

function renderFile(overrides: Partial<React.ComponentProps<typeof DiffFileView>> = {}) {
  const props = {
    file: FILE,
    view: "unified" as const,
    selectedLine: null,
    cursorsByLine: NO_CURSORS,
    renderBelow: nothing,
    onLineSelect: vi.fn(),
    ...overrides,
  };
  render(<DiffFileView {...props} />);
  return props;
}

describe("DiffFileView, unified", () => {
  it("renders each line's text with its new-side line number", () => {
    renderFile();
    const row = screen.getByTestId("line-src/total.ts-11");
    expect(codeText(row)).toBe("    sum += item.price * item.quantity;");
    expect(within(row).getByTestId("new-line-number")).toHaveTextContent("11");
  });

  it("gives a removed line an old-side number and no new-side number", () => {
    // A removed line has no position in the new file. Numbering it on the
    // new side would let a reviewer anchor a comment to a line that is gone.
    renderFile();
    const removed = screen.getByTestId("removed-src/total.ts-11");
    expect(within(removed).getByTestId("old-line-number")).toHaveTextContent("11");
    expect(within(removed).queryByTestId("new-line-number")).toBeNull();
  });

  it("reports the new-side line number when a line's gutter is clicked", async () => {
    const props = renderFile();
    await userEvent.click(screen.getByTestId("anchor-src/total.ts-12"));
    expect(props.onLineSelect).toHaveBeenCalledWith(12);
  });

  it("offers no anchor control on a removed line", () => {
    // The brief's own version of this test queries a testid
    // ("anchor-src/total.ts-removed-11") that this renderer would never
    // produce under any implementation -- new-side anchor ids are keyed by
    // new-side line numbers, and a removed line has none. That made the
    // check pass vacuously. Scoping the query inside the removed row's own
    // element, and asking for any button at all, is the version that would
    // actually fail if an anchor control leaked onto a removed line.
    renderFile();
    const removed = screen.getByTestId("removed-src/total.ts-11");
    expect(within(removed).queryByRole("button")).toBeNull();
    expect(within(removed).queryByTestId(/^anchor-/u)).toBeNull();
  });

  it("renders whatever renderBelow returns directly under that line, exactly once", () => {
    renderFile({ renderBelow: (line) => (line === 11 ? <p>thread here</p> : null) });
    const row = screen.getByTestId("line-src/total.ts-11");
    expect(within(row.parentElement!).getByText("thread here")).toBeInTheDocument();
    expect(screen.getAllByText("thread here")).toHaveLength(1);
  });

  it("shows which reviewers have their cursor on a line", () => {
    renderFile({ cursorsByLine: new Map([[12, ["grace"]]]) });
    expect(screen.getByTestId("cursors-src/total.ts-12")).toHaveTextContent("grace");
    expect(screen.queryByTestId("cursors-src/total.ts-11")).toBeNull();
  });

  it("reflects the selected line on its own row and no other", () => {
    // selectedLine is a required prop precisely so a future caller (Task 17)
    // cannot forget to wire it. This proves the renderer actually reads it
    // rather than accepting and ignoring it.
    renderFile({ selectedLine: 12 });
    expect(screen.getByTestId("line-src/total.ts-12")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("line-src/total.ts-11")).toHaveAttribute("data-selected", "false");
  });

  it("does not render or expose an anchor for a line number in the gap between two hunks", () => {
    // The project's central claim: AnchorTarget.lines is sparse, exposing
    // only what the diff's hunks cover. A renderer that filled the gap
    // between hunks with blank rows would offer an anchor on a line the
    // sparse map (and therefore relocate()) has never heard of.
    const gappy: FileDiff = {
      kind: "patch",
      path: "src/gap.ts",
      previousPath: null,
      blobSha: "sha-gap",
      status: "modified",
      hunks: parseUnifiedDiff(
        ["@@ -10,2 +10,2 @@", " a", "-b", "+c", "@@ -30,2 +30,2 @@", " x", "-y", "+z"].join("\n")
      ),
    };
    render(
      <DiffFileView
        file={gappy}
        view="unified"
        selectedLine={null}
        cursorsByLine={NO_CURSORS}
        renderBelow={nothing}
        onLineSelect={vi.fn()}
      />
    );
    // Hunk 1 exposes new lines 10-11, hunk 2 exposes new lines 30-31. Line 20
    // sits in the untouched gap between them and must not be anchorable.
    expect(screen.queryByTestId("line-src/gap.ts-20")).toBeNull();
    expect(screen.queryByTestId("anchor-src/gap.ts-20")).toBeNull();
    // The exposed lines on either side of the gap are still there.
    expect(screen.getByTestId("line-src/gap.ts-10")).toBeInTheDocument();
    expect(screen.getByTestId("line-src/gap.ts-31")).toBeInTheDocument();
  });

  it("renders a pure deletion hunk with no anchorable new-side rows at all", () => {
    // Every line in the hunk is removed -- there is no new-side content to
    // anchor to. Guards against a renderer that assumes at least one
    // context/added line exists per hunk.
    const wholeFileDeleted: FileDiff = {
      kind: "patch",
      path: "src/gone.ts",
      previousPath: null,
      blobSha: "sha-gone",
      status: "removed",
      hunks: parseUnifiedDiff(["@@ -1,2 +0,0 @@", "-first", "-second"].join("\n")),
    };
    render(
      <DiffFileView
        file={wholeFileDeleted}
        view="unified"
        selectedLine={null}
        cursorsByLine={NO_CURSORS}
        renderBelow={nothing}
        onLineSelect={vi.fn()}
      />
    );
    expect(screen.getByTestId("removed-src/gone.ts-1")).toHaveTextContent("first");
    expect(screen.getByTestId("removed-src/gone.ts-2")).toHaveTextContent("second");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByTestId(/^line-/u)).toBeNull();
  });

  it("renders a pure insertion hunk, with no context line, as fully anchorable", () => {
    // Guards against an off-by-one that assumes hunk.lines[0] is context.
    const brandNew: FileDiff = {
      kind: "patch",
      path: "src/new.ts",
      previousPath: null,
      blobSha: "sha-new",
      status: "added",
      hunks: parseUnifiedDiff(["@@ -0,0 +1,2 @@", "+first", "+second"].join("\n")),
    };
    render(
      <DiffFileView
        file={brandNew}
        view="unified"
        selectedLine={null}
        cursorsByLine={NO_CURSORS}
        renderBelow={nothing}
        onLineSelect={vi.fn()}
      />
    );
    expect(screen.getByTestId("line-src/new.ts-1")).toHaveTextContent("first");
    expect(screen.getByTestId("line-src/new.ts-2")).toHaveTextContent("second");
    expect(screen.getByTestId("anchor-src/new.ts-1")).toBeInTheDocument();
    expect(screen.getByTestId("anchor-src/new.ts-2")).toBeInTheDocument();
  });

  it("renders the line before a missing final newline without leaking the marker text", () => {
    const noEol: FileDiff = {
      kind: "patch",
      path: "src/eof.ts",
      previousPath: null,
      blobSha: "sha-eof",
      status: "modified",
      hunks: parseUnifiedDiff(
        ["@@ -1,1 +1,1 @@", "-a", "\\ No newline at end of file", "+b"].join("\n")
      ),
    };
    render(
      <DiffFileView
        file={noEol}
        view="unified"
        selectedLine={null}
        cursorsByLine={NO_CURSORS}
        renderBelow={nothing}
        onLineSelect={vi.fn()}
      />
    );
    const row = screen.getByTestId("line-src/eof.ts-1");
    expect(within(row).getByText("b")).toBeInTheDocument();
    expect(row).not.toHaveTextContent(/no newline/iu);
  });

  it("explains a pure rename with no content change instead of an empty diff", () => {
    const renamedOnly: FileDiff = {
      kind: "patch",
      path: "src/renamed-to.ts",
      previousPath: "src/renamed-from.ts",
      blobSha: "sha-same",
      status: "renamed",
      hunks: [],
    };
    render(
      <DiffFileView
        file={renamedOnly}
        view="unified"
        selectedLine={null}
        cursorsByLine={NO_CURSORS}
        renderBelow={nothing}
        onLineSelect={vi.fn()}
      />
    );
    expect(screen.getByTestId("no-changes-src/renamed-to.ts")).toHaveTextContent(
      /renamed from src\/renamed-from\.ts/iu
    );
    // And, as with an omitted file, nothing anchorable: there is no content
    // here for a comment to attach to.
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByTestId(/^anchor-/u)).toBeNull();
  });

  it("explains an omitted file instead of rendering an empty diff", () => {
    render(
      <DiffFileView
        file={{
          kind: "omitted",
          path: "assets/logo.png",
          previousPath: null,
          blobSha: "sha-bin",
          status: "modified",
          reason: "binary",
        }}
        view="unified"
        selectedLine={null}
        cursorsByLine={NO_CURSORS}
        renderBelow={nothing}
        onLineSelect={vi.fn()}
      />
    );
    expect(screen.getByTestId("omitted-assets/logo.png")).toHaveTextContent(/binary/iu);
    // And nothing anchorable, so no comment can be attached to content that
    // was never delivered.
    expect(screen.queryByTestId(/^anchor-/u)).toBeNull();
  });
});

describe("DiffFileView, split", () => {
  it("puts removals on the left and additions on the right", () => {
    renderFile({ view: "split" });
    // Row 0 is the leading context line; the removal/addition pair is row 1.
    const row = screen.getByTestId("split-row-src/total.ts-1");
    expect(codeText(within(row).getByTestId("split-left"))).toBe("    sum += item.price;");
    expect(codeText(within(row).getByTestId("split-right"))).toBe(
      "    sum += item.price * item.quantity;"
    );
  });

  it("keeps the same new-side line number for the same code as unified view", () => {
    // The spec's motivating case. The anchor is to a blob and a line, so a
    // view change must not move it -- if this test ever disagreed with the
    // unified test above, every thread would jump on a layout toggle.
    renderFile({ view: "split" });
    const row = screen.getByTestId("line-src/total.ts-11");
    expect(within(row).getByTestId("new-line-number")).toHaveTextContent("11");
    expect(codeText(row)).toBe("    sum += item.price * item.quantity;");
  });

  it("renders renderBelow content once, not once per side", () => {
    renderFile({ view: "split", renderBelow: (line) => (line === 11 ? <p>thread here</p> : null) });
    expect(screen.getAllByText("thread here")).toHaveLength(1);
  });

  it("offers no anchor control on the spacer row opposite a pure removal", () => {
    // The extra added line ("audit(item);", new line 12) has no removed
    // counterpart, so its row's left cell is a layout-only spacer -- but
    // that is the *addition* case. This test covers the mirror case: a
    // removal with nothing to its right. Build a hunk where a removal run
    // is longer than the addition run that follows it.
    const extraRemoval: FileDiff = {
      kind: "patch",
      path: "src/shrink.ts",
      previousPath: null,
      blobSha: "sha-shrink",
      status: "modified",
      hunks: parseUnifiedDiff(["@@ -1,2 +1,1 @@", "-old one", "-old two", "+new one"].join("\n")),
    };
    render(
      <DiffFileView
        file={extraRemoval}
        view="split"
        selectedLine={null}
        cursorsByLine={NO_CURSORS}
        renderBelow={nothing}
        onLineSelect={vi.fn()}
      />
    );
    // Row 0 pairs "old one" / "new one". Row 1 is "old two" with nothing on
    // the right -- a layout-only spacer, not a place to anchor a comment.
    const spacerRow = screen.getByTestId("split-row-src/shrink.ts-1");
    expect(within(spacerRow).getByTestId("split-left")).toHaveTextContent("old two");
    expect(within(spacerRow).queryByRole("button")).toBeNull();
    expect(within(spacerRow).queryByTestId(/^line-/u)).toBeNull();
    expect(within(spacerRow).queryByTestId(/^anchor-/u)).toBeNull();
  });

  it("offers no anchor control on the spacer cell opposite a pure insertion", () => {
    // "audit(item);" (new line 12) has no removed counterpart -- its row's
    // left cell is the layout-only spacer. The anchor for that row belongs
    // only to the right (new-side) cell.
    renderFile({ view: "split" });
    const row = screen
      .getByTestId("line-src/total.ts-12")
      .closest('[data-testid^="split-row-"]') as HTMLElement | null;
    if (row === null) throw new Error("expected a split-row ancestor");
    const left = within(row).getByTestId("split-left");
    expect(within(left).queryByRole("button")).toBeNull();
    expect(within(left).queryByTestId(/^anchor-/u)).toBeNull();
  });

  it("keeps split rows unique and correctly paired across multiple hunks in one file", () => {
    // The concrete failure mode this guards against: indexing split rows by
    // a counter that resets to 0 for every hunk produces duplicate
    // `split-row-*` testids the moment a file has more than one hunk, and
    // silently aliases one hunk's rows onto another's.
    const twoHunks: FileDiff = {
      kind: "patch",
      path: "src/two.ts",
      previousPath: null,
      blobSha: "sha-two",
      status: "modified",
      hunks: parseUnifiedDiff(
        [
          "@@ -1,2 +1,2 @@",
          "-first old",
          "+first new",
          " shared one",
          "@@ -20,2 +20,2 @@",
          "-second old",
          "+second new",
          " shared two",
        ].join("\n")
      ),
    };
    render(
      <DiffFileView
        file={twoHunks}
        view="split"
        selectedLine={null}
        cursorsByLine={NO_CURSORS}
        renderBelow={nothing}
        onLineSelect={vi.fn()}
      />
    );
    const rows = screen.getAllByTestId(/^split-row-src\/two\.ts-/u);
    const ids = rows.map((row) => row.getAttribute("data-testid"));
    expect(new Set(ids).size).toBe(ids.length); // no two rows share an id

    const firstPairRow = screen.getByTestId("split-row-src/two.ts-0");
    expect(within(firstPairRow).getByTestId("split-left")).toHaveTextContent("first old");
    expect(within(firstPairRow).getByTestId("split-right")).toHaveTextContent("first new");

    const secondPairRow = screen.getByTestId("split-row-src/two.ts-2");
    expect(within(secondPairRow).getByTestId("split-left")).toHaveTextContent("second old");
    expect(within(secondPairRow).getByTestId("split-right")).toHaveTextContent("second new");
  });

  it("puts a whole-file deletion entirely on the left, with no anchor anywhere", () => {
    const wholeFileDeleted: FileDiff = {
      kind: "patch",
      path: "src/gone.ts",
      previousPath: null,
      blobSha: "sha-gone",
      status: "removed",
      hunks: parseUnifiedDiff(["@@ -1,2 +0,0 @@", "-first", "-second"].join("\n")),
    };
    render(
      <DiffFileView
        file={wholeFileDeleted}
        view="split"
        selectedLine={null}
        cursorsByLine={NO_CURSORS}
        renderBelow={nothing}
        onLineSelect={vi.fn()}
      />
    );
    expect(screen.getByTestId("split-row-src/gone.ts-0")).toHaveTextContent("first");
    expect(screen.getByTestId("split-row-src/gone.ts-1")).toHaveTextContent("second");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByTestId(/^line-/u)).toBeNull();
    expect(screen.queryByTestId(/^anchor-/u)).toBeNull();
  });
});

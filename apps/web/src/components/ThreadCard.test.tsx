import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Thread } from "@diffsync/threads";
import { ThreadCard } from "./ThreadCard";

const thread: Thread = {
  threadId: "t1",
  anchor: {
    filePath: "src/a.ts",
    blobSha: "sha-1",
    line: 12,
    fingerprint: "0123456789abcdef",
    context: ["a", "b", "c", "d", "e", "f", "g"],
  },
  comments: [
    { commentId: "c1", reviewerId: "r1", nickname: "ada", body: "this double-counts", atMs: 1 },
    { commentId: "c2", reviewerId: "r2", nickname: "grace", body: "agreed", atMs: 2 },
  ],
  resolved: false,
  resolvedBy: null,
};

function renderCard(overrides: Partial<React.ComponentProps<typeof ThreadCard>> = {}) {
  const props = {
    thread,
    onReply: vi.fn(),
    onResolve: vi.fn(),
    onUnresolve: vi.fn(),
    ...overrides,
  };
  render(<ThreadCard {...props} />);
  return props;
}

describe("ThreadCard", () => {
  it("shows every comment, attributed, in order", () => {
    renderCard();
    const comments = screen.getAllByTestId(/^comment-/u);
    expect(comments[0]).toHaveTextContent("ada");
    expect(comments[0]).toHaveTextContent("this double-counts");
    expect(comments[1]).toHaveTextContent("grace");
    expect(comments[1]).toHaveTextContent("agreed");
  });

  it("sends a reply and clears the box", async () => {
    const props = renderCard();
    await userEvent.type(screen.getByRole("textbox"), "fixed in the next push");
    await userEvent.click(screen.getByRole("button", { name: /reply/iu }));
    expect(props.onReply).toHaveBeenCalledWith("fixed in the next push");
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("offers resolve while open, and unresolve once resolved", async () => {
    const props = renderCard();
    await userEvent.click(screen.getByRole("button", { name: /^resolve$/iu }));
    expect(props.onResolve).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /unresolve/iu })).toBeNull();
  });

  it("says who resolved it and offers to reopen", async () => {
    // `resolvedBy` holds a `reviewerId` (see packages/threads/src/types.ts),
    // not a nickname -- "r2" is grace's id in the fixture above. The card
    // must resolve that id to her name via her own comment, not print it
    // raw.
    const props = renderCard({ thread: { ...thread, resolved: true, resolvedBy: "r2" } });
    expect(screen.getByTestId("resolved-by")).toHaveTextContent("grace");
    await userEvent.click(screen.getByRole("button", { name: /unresolve/iu }));
    expect(props.onUnresolve).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^resolve$/iu })).toBeNull();
  });

  it("still shows the comments of a resolved thread", () => {
    // Collapsing them away would make a resolved thread indistinguishable from
    // a deleted one, and the log is append-only: nothing is ever deleted.
    renderCard({ thread: { ...thread, resolved: true, resolvedBy: "r2" } });
    expect(screen.getAllByTestId(/^comment-/u)).toHaveLength(2);
  });

  it("never shows a raw reviewer id when the resolver can't be identified", () => {
    // Catches the regression this component actually shipped with: resolving
    // `thread.resolvedBy` -- a bare reviewerId -- straight into the page
    // whenever no comment (and no presence entry) can vouch for a nickname.
    // A resolver who resolved without ever commenting, or who has since
    // disconnected (presence only lists reviewers who are still connected),
    // leaves nothing to resolve the id to. This must degrade to "Resolved"
    // with no identifier at all, never to the id itself.
    const unknownReviewerId = "998e3452-7f46-425a-add2-dcd2fc1a6e71";
    renderCard({ thread: { ...thread, resolved: true, resolvedBy: unknownReviewerId } });
    const resolvedBy = screen.getByTestId("resolved-by");
    expect(resolvedBy).toHaveTextContent("Resolved");
    expect(resolvedBy.textContent).not.toContain(unknownReviewerId);
    expect(resolvedBy).toHaveTextContent(/^Resolved$/u);
  });
});

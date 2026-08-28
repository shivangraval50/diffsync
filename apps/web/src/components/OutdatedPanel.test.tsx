import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { GAP } from "@diffsync/anchor";
import type { PlacedThread } from "@diffsync/threads";
import { OutdatedPanel } from "./OutdatedPanel";

const outdated: PlacedThread[] = [
  {
    placement: { kind: "outdated" },
    thread: {
      threadId: "t1",
      anchor: {
        filePath: "src/auth/token.ts",
        blobSha: "blob-token-r1",
        line: 5,
        fingerprint: "0123456789abcdef",
        context: [
          GAP,
          GAP,
          '  const header = { alg: "HS256" };',
          "  const body = encode({ ...payload, iat: Date.now() });",
          "  const sig = sign(header, body, SECRET);",
          '  return [header, body].join(".");',
          "}",
        ],
      },
      comments: [
        { commentId: "c1", reviewerId: "r1", nickname: "ada", body: "signature order?", atMs: 1 },
      ],
      resolved: false,
      resolvedBy: null,
    },
  },
];

describe("OutdatedPanel", () => {
  it("says nothing when every thread is still located", () => {
    render(<OutdatedPanel threads={[]} />);
    expect(screen.queryByTestId("outdated-panel")).toBeNull();
  });

  it("names the file and line the thread was written against", () => {
    render(<OutdatedPanel threads={outdated} />);
    expect(screen.getByTestId("outdated-t1")).toHaveTextContent("src/auth/token.ts:5");
  });

  it("quotes the original code, which is the whole point of keeping it", () => {
    render(<OutdatedPanel threads={outdated} />);
    const quote = within(screen.getByTestId("outdated-t1")).getByTestId("quoted-context");
    expect(quote).toHaveTextContent("const body = encode({ ...payload, iat: Date.now() });");
  });

  it("does not render the GAP sentinel as if it were a line of code", () => {
    // GAP fills window slots past the start of a file and begins with U+0000.
    // Printing it verbatim would put a control character in the quoted diff.
    render(<OutdatedPanel threads={outdated} />);
    const quote = within(screen.getByTestId("outdated-t1")).getByTestId("quoted-context");
    expect(quote.textContent ?? "").not.toContain(GAP);
  });

  it("explains why the thread is detached", () => {
    render(<OutdatedPanel threads={outdated} />);
    expect(screen.getByTestId("outdated-panel")).toHaveTextContent(
      /the code it was written about has changed/iu
    );
  });

  it("still shows the conversation", () => {
    render(<OutdatedPanel threads={outdated} />);
    expect(screen.getByTestId("outdated-t1")).toHaveTextContent("signature order?");
  });
});

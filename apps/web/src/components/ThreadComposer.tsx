"use client";

import { useState } from "react";

export function ThreadComposer({
  filePath,
  line,
  onSubmit,
  onCancel,
}: {
  filePath: string;
  line: number;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [body, setBody] = useState("");
  const trimmed = body.trim();

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed === "") return;
        onSubmit(trimmed);
        setBody("");
      }}
    >
      <p data-testid="composer-target">{`${filePath}:${line}`}</p>
      <label htmlFor="thread-body">Your comment</label>
      <textarea id="thread-body" value={body} onChange={(event) => setBody(event.target.value)} />
      {/* Gated on the TRIMMED body: a comment of only spaces passes a length
          check here and then fails the protocol's `.min(1)` on the wire,
          closing the socket instead of telling the reviewer anything. */}
      <button type="submit" disabled={trimmed === ""}>
        Comment
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

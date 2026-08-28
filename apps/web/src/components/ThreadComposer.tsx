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
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed === "") return;
        onSubmit(trimmed);
        setBody("");
      }}
    >
      <p data-testid="composer-target" className="composer__target">{`${filePath}:${line}`}</p>
      <label htmlFor="thread-body" className="label">
        Your comment
      </label>
      <textarea
        id="thread-body"
        className="field"
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      {/* Cancel then Comment, so the confirming action is the trailing one.
          Gated on the TRIMMED body: a comment of only spaces passes a length
          check here and then fails the protocol's `.min(1)` on the wire,
          closing the socket instead of telling the reviewer anything. */}
      <div className="composer__actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" disabled={trimmed === ""}>
          Comment
        </button>
      </div>
    </form>
  );
}

"use client";

import { useState } from "react";
import type { FileDiff } from "@diffsync/diff";
import { DiffPanel } from "./DiffPanel";

const NO_CURSORS: ReadonlyMap<string, ReadonlyMap<number, readonly string[]>> = new Map();

/**
 * Owns the interactive state `DiffPanel`'s props require -- selection,
 * cursors, per-line thread content -- so `pr/[key]/page.tsx` never has to
 * pass a function prop across the server/client boundary. `page.tsx` is an
 * async Server Component (it awaits `fetchSource`); React does not let a
 * Server Component pass a plain closure to a Client Component, so
 * `renderBelow`/`onLineSelect` have to originate on this side of the
 * boundary. This is a placeholder, not the real thing: Task 17 replaces the
 * cursor map and `renderBelow` with live presence and real threads. Until
 * then there is simply no thread or presence data yet -- `DiffPanel`'s
 * required props stay honestly wired rather than silently dropped.
 */
export function DiffPanelHost({ files }: { files: FileDiff[] }): React.JSX.Element {
  const [selectedLine, setSelectedLine] = useState<number | null>(null);

  return (
    <DiffPanel
      files={files}
      selectedLine={selectedLine}
      cursorsByLine={NO_CURSORS}
      renderBelow={() => null}
      onLineSelect={(_path, line) => setSelectedLine(line)}
    />
  );
}

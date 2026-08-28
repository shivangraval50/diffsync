"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { useRouter } from "next/navigation";
import type { SourceResult } from "@diffsync/protocol";
import { DiffPanel } from "@/components/DiffPanel";
import { PresenceBar } from "@/components/PresenceBar";
import { createReviewStore } from "@/lib/reviewStore";
import { connectPr, type PrConnection } from "@/lib/socket";

export function ReviewSurface({
  prKey,
  source,
  nickname,
  persistent,
}: {
  prKey: string;
  source: SourceResult;
  nickname: string;
  persistent: boolean;
}): React.JSX.Element {
  // Keyed on `prKey`, not created once for the component's whole lifetime:
  // a different pull request is a different thread log and a different
  // presence roster, and reusing one store across a `prKey` change would
  // show the new PR's diff above the previous PR's threads until a snapshot
  // happened to arrive and overwrite them. Deliberately NOT keyed on
  // `nickname`/`persistent` -- those can change without the underlying
  // review session changing (e.g. signing in mid-visit), and `socket.ts`'s
  // own supersession handling (see `connectPr`'s `close()`) is what keeps a
  // superseded connection from corrupting a store it still shares with its
  // replacement in that case.
  const store = useMemo(() => createReviewStore(), [prKey]);
  const connection = useRef<PrConnection | null>(null);
  const [selected, setSelected] = useState<{ path: string; line: number } | null>(null);
  const router = useRouter();

  const threads = useStore(store, (s) => s.threads);
  const presence = useStore(store, (s) => s.presence);
  const youAre = useStore(store, (s) => s.youAre);
  const status = useStore(store, (s) => s.status);

  useEffect(() => {
    const base = process.env.NEXT_PUBLIC_PRS_BASE_URL ?? "";
    const conn = connectPr({
      url: `${base.replace(/^http/u, "ws")}/prs/${prKey}/ws`,
      nickname,
      persistent,
      store,
      // The diff itself is server-rendered, so a new head sha means this
      // page's HTML is stale. Refresh rather than patch: half a room
      // commenting against a revision that no longer exists would have every
      // one of those comments rejected as STALE_ANCHOR.
      onSourceChanged: () => router.refresh(),
    });
    connection.current = conn;
    // `conn.close()` is what makes a re-run of this effect safe even though
    // `store` above can stay the same object across it (any dependency other
    // than `prKey` changing): it detaches this connection's own websocket
    // handlers synchronously, before starting the connection that replaces
    // it, so a close event delivered later for THIS socket can never reach
    // back into the shared store and report stale status over the
    // replacement's. See `connectPr`'s `close()` for the full mechanism.
    return () => conn.close();
  }, [prKey, nickname, persistent, store, router]);

  const cursorsByLine = useMemo(() => {
    const byFile = new Map<string, Map<number, string[]>>();
    for (const reviewer of presence) {
      if (reviewer.cursor === null || reviewer.reviewerId === youAre) continue;
      const lines = byFile.get(reviewer.cursor.filePath) ?? new Map<number, string[]>();
      lines.set(reviewer.cursor.line, [
        ...(lines.get(reviewer.cursor.line) ?? []),
        reviewer.nickname,
      ]);
      byFile.set(reviewer.cursor.filePath, lines);
    }
    return byFile;
  }, [presence, youAre]);

  return (
    <div>
      <PresenceBar presence={presence} youAre={youAre} status={status} />
      <DiffPanel
        files={source.pr.files}
        selectedLine={selected?.line ?? null}
        cursorsByLine={cursorsByLine}
        renderBelow={() => null}
        onLineSelect={(path, line) => {
          setSelected({ path, line });
          connection.current?.send({ t: "cursor", filePath: path, line });
        }}
      />
      <p data-testid="thread-count">{threads.order.length}</p>
    </div>
  );
}

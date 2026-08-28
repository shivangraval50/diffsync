"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { useRouter } from "next/navigation";
import { createAnchor } from "@diffsync/anchor";
import { anchorTargets } from "@diffsync/diff";
import { aiPassSchema, type AiPass, type SourceResult } from "@diffsync/protocol";
import { placeThreads } from "@diffsync/threads";
import { AiPanel } from "@/components/AiPanel";
import { DiffPanel } from "@/components/DiffPanel";
import { OutdatedPanel } from "@/components/OutdatedPanel";
import { PresenceBar } from "@/components/PresenceBar";
import { RejectBanner } from "@/components/RejectBanner";
import { ThreadCard } from "@/components/ThreadCard";
import { ThreadComposer } from "@/components/ThreadComposer";
import { layoutThreads } from "@/lib/threadLayout";
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
  const [aiPass, setAiPass] = useState<AiPass | null>(null);
  const router = useRouter();

  const threads = useStore(store, (s) => s.threads);
  const presence = useStore(store, (s) => s.presence);
  const youAre = useStore(store, (s) => s.youAre);
  const status = useStore(store, (s) => s.status);
  const lastReject = useStore(store, (s) => s.lastReject);

  const clientSeq = useRef(0);
  const nextClientSeq = (): number => {
    clientSeq.current += 1;
    return clientSeq.current;
  };

  // Recomputed on every render from the anchors and the CURRENT source.
  // Nothing about a thread's position is cached, so a thread cannot be drawn
  // at a position that was true for a revision this page is not showing.
  const targets = useMemo(() => anchorTargets(source.pr), [source]);
  const layout = useMemo(() => layoutThreads(placeThreads(threads, targets)), [threads, targets]);

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

  useEffect(() => {
    let cancelled = false;
    // Decoration, fetched once per pull request: a failed request (no key
    // configured server-side, a Worker blip, a malformed body) means no
    // panel, never a broken review -- so this deliberately has no error
    // state and no retry, only a `.catch` that leaves `aiPass` at `null`.
    void fetch(`/api/ai/${prKey}`)
      .then((res) => res.json())
      .then((body: unknown) => {
        const parsed = aiPassSchema.safeParse((body as { pass?: unknown } | null)?.pass ?? null);
        if (!cancelled && parsed.success) setAiPass(parsed.data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [prKey]);

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
      <AiPanel pass={aiPass} />
      <DiffPanel
        files={source.pr.files}
        selected={selected}
        cursorsByLine={cursorsByLine}
        renderBelow={(path, line) => {
          const here = layout.located.get(path)?.get(line) ?? [];
          const composing = selected !== null && selected.path === path && selected.line === line;
          if (here.length === 0 && !composing) return null;
          return (
            <div>
              {here.map(({ thread }) => (
                <ThreadCard
                  key={thread.threadId}
                  thread={thread}
                  onReply={(body) =>
                    connection.current?.send({
                      t: "reply",
                      clientSeq: nextClientSeq(),
                      threadId: thread.threadId,
                      body,
                    })
                  }
                  onResolve={() =>
                    connection.current?.send({
                      t: "resolve",
                      clientSeq: nextClientSeq(),
                      threadId: thread.threadId,
                    })
                  }
                  onUnresolve={() =>
                    connection.current?.send({
                      t: "unresolve",
                      clientSeq: nextClientSeq(),
                      threadId: thread.threadId,
                    })
                  }
                />
              ))}
              {composing ? (
                <ThreadComposer
                  filePath={path}
                  line={line}
                  onCancel={() => setSelected(null)}
                  onSubmit={(body) => {
                    const target = targets.get(path);
                    if (target === undefined) return;
                    // Built from the source this page is rendering, so the
                    // Durable Object's own recomputation either matches it or
                    // rejects it as STALE_ANCHOR. The reviewer's position is
                    // never inferred server-side from a bare line number.
                    const anchor = createAnchor(target, line);
                    if (anchor === null) return;
                    connection.current?.send({
                      t: "openThread",
                      clientSeq: nextClientSeq(),
                      anchor,
                      body,
                    });
                    setSelected(null);
                  }}
                />
              ) : null}
            </div>
          );
        }}
        onLineSelect={(path, line) => {
          setSelected({ path, line });
          connection.current?.send({ t: "cursor", filePath: path, line });
        }}
      />
      <RejectBanner reject={lastReject} />
      <OutdatedPanel threads={layout.outdated} />
    </div>
  );
}

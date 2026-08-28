import { encode, parseServerMessage, type ClientMessage } from "@diffsync/protocol";
import type { ReviewStore } from "./reviewStore";

export function backoffMs(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** attempt);
}

export interface PrConnection {
  send(msg: ClientMessage): void;
  close(): void;
}

export function connectPr(opts: {
  url: string;
  nickname: string;
  /** Whether `nickname` is a signed-in GitHub login. Required rather than
   *  optional: an omitted flag would silently label a signed-in reviewer as a
   *  guest, which is exactly the quiet drop an optional parameter invites. */
  persistent: boolean;
  store: ReviewStore;
  onSourceChanged: (headSha: string) => void;
}): PrConnection {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let disposed = false;

  function open(): void {
    if (disposed) return;
    opts.store.getState().setStatus(attempt === 0 ? "connecting" : "reconnecting");
    const socket = new WebSocket(opts.url);
    ws = socket;

    socket.onopen = () => {
      attempt = 0;
      opts.store.getState().setStatus("open");
      // Read fresh, not captured at connect time, so a reconnect always
      // resumes from the highest sequence genuinely applied via a delta or a
      // snapshot -- never from whatever `lastSeenSeq` happened to be when
      // `connectPr` was first called.
      socket.send(
        encode({
          t: "hello",
          lastSeenSeq: opts.store.getState().lastSeenSeq,
          nickname: opts.nickname,
          persistent: opts.persistent,
        })
      );
    };

    socket.onmessage = (event) => {
      // `parseServerMessage` throws on a malformed or schema-invalid frame,
      // and an exception escaping `onmessage` is unhandled. Dropped, not
      // fatal: this side is not the authority, and a dropped delta leaves
      // `lastSeenSeq` where it was, so the Durable Object replays it on the
      // next reconnect -- a recoverable hole, versus a dead client.
      let msg;
      try {
        msg = parseServerMessage(String(event.data));
      } catch {
        return;
      }
      if (msg.t === "sourceChanged") opts.onSourceChanged(msg.headSha);
      opts.store.getState().applyServerMessage(msg);
    };

    socket.onclose = () => {
      if (disposed) {
        opts.store.getState().setStatus("closed");
        return;
      }
      const delay = backoffMs(attempt);
      attempt += 1;
      opts.store.getState().setStatus("reconnecting");
      setTimeout(open, delay);
    };

    socket.onerror = () => socket.close();
  }

  open();

  return {
    send(msg) {
      if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(encode(msg));
    },
    close() {
      disposed = true;
      opts.store.getState().setStatus("closed");
      const socket = ws;
      if (socket !== null) {
        // Detached synchronously, before `socket.close()` even starts the
        // real (asynchronous) close handshake. A superseded connection is
        // torn down by the effect that owns its lifecycle calling THIS
        // `close()` before starting a replacement on the very same store
        // (see ReviewSurface) -- but the browser still delivers this
        // socket's own "close" event later, on its own schedule, and by
        // then a newer connection may already have reported "open" into
        // that shared store. Nulling the handlers here -- rather than
        // leaving `onclose` to check `disposed` and write "closed" anyway --
        // means that later event finds no handler at all and can never
        // reach back in to overwrite the replacement's status. This is
        // exactly openbid's bug: "cleanup closes A -> B opens and reports
        // open -> A's queued onclose fires and overwrites it with closed",
        // fixed at its source instead of raced against.
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
      }
    },
  };
}

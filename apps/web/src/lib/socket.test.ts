import { describe, it, expect, vi, beforeEach } from "vitest";
import { encode, type ClientMessage } from "@diffsync/protocol";
import { createReviewStore } from "./reviewStore";
import { backoffMs, connectPr } from "./socket";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  parsedSent(): ClientMessage[] {
    return this.sent.map((raw) => JSON.parse(raw) as ClientMessage);
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

describe("backoffMs", () => {
  it("grows exponentially and then stops growing", () => {
    expect(backoffMs(0)).toBe(500);
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(20)).toBe(30_000);
  });
});

describe("connectPr", () => {
  it("says hello with the nickname and the current resume position", () => {
    const store = createReviewStore();
    store.getState().applyServerMessage({
      t: "snapshot",
      seq: 7,
      serverTime: 1,
      youAre: "r1",
      threads: { threads: {}, order: [] },
      presence: [],
    });

    connectPr({
      url: "wss://prs.test/prs/k/ws",
      nickname: "ada",
      persistent: false,
      store,
      onSourceChanged: vi.fn(),
    });
    const socket = FakeWebSocket.instances[0]!;
    socket.onopen?.();

    expect(socket.parsedSent()[0]).toEqual({
      t: "hello",
      lastSeenSeq: 7,
      nickname: "ada",
      persistent: false,
    });
  });

  it("reads the resume position fresh at reconnect, not at connect", () => {
    // Capturing it once would replay from a stale point after every drop, so a
    // reviewer who reconnected would either miss comments or see them twice.
    // The store genuinely advances (0 -> 12) between the first connect and
    // the drop -- a real gap, not a reconnect with nothing to resume.
    vi.useFakeTimers();
    try {
      const store = createReviewStore();
      connectPr({
        url: "wss://prs.test/prs/k/ws",
        nickname: "ada",
        persistent: false,
        store,
        onSourceChanged: vi.fn(),
      });
      const first = FakeWebSocket.instances[0]!;
      first.onopen?.();
      expect(first.parsedSent()[0]).toMatchObject({ lastSeenSeq: 0 });

      store.getState().applyServerMessage({
        t: "snapshot",
        seq: 12,
        serverTime: 1,
        youAre: "r1",
        threads: { threads: {}, order: [] },
        presence: [],
      });

      first.close();
      vi.advanceTimersByTime(backoffMs(0));

      const reconnected = FakeWebSocket.instances[1];
      expect(reconnected).toBeDefined();
      reconnected?.onopen?.();
      // Captured at connect time this would still say 0, and the Durable
      // Object would replay twelve events the client already has.
      expect(reconnected?.parsedSent()[0]).toMatchObject({ lastSeenSeq: 12 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies a server message to the store", () => {
    const store = createReviewStore();
    connectPr({
      url: "wss://prs.test/prs/k/ws",
      nickname: "ada",
      persistent: false,
      store,
      onSourceChanged: vi.fn(),
    });
    const socket = FakeWebSocket.instances[0]!;
    socket.onopen?.();
    socket.onmessage?.({
      data: encode({
        t: "snapshot",
        seq: 3,
        serverTime: 1,
        youAre: "r9",
        threads: { threads: {}, order: [] },
        presence: [],
      }),
    });
    expect(store.getState().youAre).toBe("r9");
  });

  it("drops a malformed frame instead of throwing out of onmessage", () => {
    // An exception escaping onmessage is unhandled. Dropping the frame leaves
    // lastSeenSeq where it was, so the Durable Object replays the gap on the
    // next reconnect -- a recoverable hole, versus a dead client.
    const store = createReviewStore();
    connectPr({
      url: "wss://prs.test/prs/k/ws",
      nickname: "ada",
      persistent: false,
      store,
      onSourceChanged: vi.fn(),
    });
    const socket = FakeWebSocket.instances[0]!;
    socket.onopen?.();
    expect(() => socket.onmessage?.({ data: "{not json" })).not.toThrow();
    expect(() => socket.onmessage?.({ data: '{"t":"nonsense"}' })).not.toThrow();
    expect(store.getState().youAre).toBeNull();
  });

  it("notifies the caller when the pull request's source changed", () => {
    const onSourceChanged = vi.fn();
    const store = createReviewStore();
    connectPr({
      url: "wss://prs.test/prs/k/ws",
      nickname: "ada",
      persistent: false,
      store,
      onSourceChanged,
    });
    const socket = FakeWebSocket.instances[0]!;
    socket.onopen?.();
    socket.onmessage?.({ data: encode({ t: "sourceChanged", headSha: "9f8e7d6" }) });
    expect(onSourceChanged).toHaveBeenCalledWith("9f8e7d6");
  });

  it("stops reconnecting once closed by the caller", () => {
    const store = createReviewStore();
    const conn = connectPr({
      url: "wss://prs.test/prs/k/ws",
      nickname: "ada",
      persistent: false,
      store,
      onSourceChanged: vi.fn(),
    });
    conn.close();
    FakeWebSocket.instances[0]!.onclose?.();
    expect(store.getState().status).toBe("closed");
  });

  it("does not reopen a socket after the caller has closed the connection", () => {
    // `close()` must be terminal: a pending backoff timer scheduled just
    // before the caller closed the connection would otherwise fire later and
    // open a socket nobody asked for anymore.
    vi.useFakeTimers();
    try {
      const store = createReviewStore();
      const conn = connectPr({
        url: "wss://prs.test/prs/k/ws",
        nickname: "ada",
        persistent: false,
        store,
        onSourceChanged: vi.fn(),
      });
      const first = FakeWebSocket.instances[0]!;
      // The transport itself drops the connection (not a caller-initiated
      // close), which schedules a reconnect via backoff.
      first.close();
      conn.close();
      vi.advanceTimersByTime(backoffMs(0) + 1_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it(
    "does not let a superseded connection's belated close event overwrite a live replacement's status",
    () => {
      // openbid's exact bug: closes are delivered asynchronously, so on a
      // remount the real order is "cleanup closes A -> B opens and reports
      // open -> A's queued onclose fires and overwrites it with closed." The
      // room showed "Disconnected." forever while the replacement sat there
      // healthy. This sequences two connections against the SAME store in
      // exactly that order -- the way ReviewSurface's effect does across a
      // remount (StrictMode's double-invoke, Fast Refresh, or a real prop
      // change), since the store persists across an effect re-run while each
      // `connectPr` call gets its own websocket.
      const store = createReviewStore();

      const connA = connectPr({
        url: "wss://prs.test/prs/k/ws",
        nickname: "ada",
        persistent: false,
        store,
        onSourceChanged: vi.fn(),
      });
      const socketA = FakeWebSocket.instances[0]!;
      socketA.onopen?.();
      expect(store.getState().status).toBe("open");

      // The owning effect's cleanup: tear down A before starting its
      // replacement, exactly as ReviewSurface's `return () => conn.close()`
      // does on every re-run.
      connA.close();

      const connB = connectPr({
        url: "wss://prs.test/prs/k/ws",
        nickname: "ada",
        persistent: false,
        store,
        onSourceChanged: vi.fn(),
      });
      const socketB = FakeWebSocket.instances[1]!;
      socketB.onopen?.();
      expect(store.getState().status).toBe("open");

      // A's own close, delivered late -- as a real WebSocket's asynchronous
      // close handshake would -- must not be able to reach back into the
      // shared store and flip a connection that is no longer live back to
      // "closed". `close()` detaches A's handlers synchronously, before this
      // point, which is what makes that true regardless of how late the
      // browser actually fires the event.
      expect(socketA.onclose).toBeNull();
      socketA.onclose?.();
      expect(store.getState().status).toBe("open");
      void connB;
    }
  );
});

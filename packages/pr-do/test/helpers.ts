import { SELF } from "cloudflare:test";
import { createAnchor, type Anchor } from "@diffsync/anchor";
import { anchorTargets } from "@diffsync/diff";
import { fixturePullRequest } from "@diffsync/fixtures";
import {
  encode,
  encodePrKey,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "@diffsync/protocol";

/** The auth-refactor fixture at revision 1. */
export function fixtureKey(): string {
  return encodePrKey({ kind: "fixture", slug: "auth-refactor", revision: 1 });
}

/**
 * The same fixture under a fresh nonce: it decodes to the same pull request but
 * names a DIFFERENT Durable Object, so tests cannot see each other's comment
 * logs. The pool runs with `isolatedStorage: false` (WebSockets require it), so
 * the nonce is the only isolation there is.
 *
 * Appending characters to the key itself would NOT work: the key is base64url
 * of a structured payload, so a suffix changes what it decodes to and the
 * Worker answers 404.
 */
export function isolatedKey(): string {
  return encodePrKey(
    { kind: "fixture", slug: "auth-refactor", revision: 1 },
    crypto.randomUUID().replace(/-/gu, "")
  );
}

export class Inbox {
  private readonly received: ServerMessage[] = [];
  private readonly waiters: {
    match: (m: ServerMessage) => boolean;
    resolve: (m: ServerMessage) => void;
  }[] = [];

  constructor(ws: WebSocket) {
    ws.addEventListener("message", (event: MessageEvent) => {
      // Parsed through the shared schema, so these tests are also the
      // client-side half of the both-ends validation rule.
      const msg = parseServerMessage(String(event.data));
      const index = this.waiters.findIndex((w) => w.match(msg));
      const waiter = index < 0 ? undefined : this.waiters.splice(index, 1)[0];
      if (waiter === undefined) this.received.push(msg);
      else waiter.resolve(msg);
    });
  }

  next(match: (m: ServerMessage) => boolean, timeoutMs = 5_000): Promise<ServerMessage> {
    const index = this.received.findIndex(match);
    if (index >= 0) return Promise.resolve(this.received.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for a message")),
        timeoutMs
      );
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }
}

export async function connect(key: string): Promise<{ ws: WebSocket; inbox: Inbox }> {
  const res = await SELF.fetch(`https://do.test/prs/${key}/ws`, {
    headers: { Upgrade: "websocket" },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error(`no websocket in response (status ${res.status})`);
  ws.accept();
  return { ws, inbox: new Inbox(ws) };
}

export function send(ws: WebSocket, msg: ClientMessage): void {
  ws.send(encode(msg));
}

export async function join(key: string, nickname: string) {
  const { ws, inbox } = await connect(key);
  send(ws, { t: "hello", lastSeenSeq: 0, nickname, persistent: false });
  const snapshot = await inbox.next((m) => m.t === "snapshot");
  if (snapshot.t !== "snapshot") throw new Error("expected a snapshot");
  return { ws, inbox, snapshot };
}

/** A genuine anchor, computed from the same fixture the Durable Object holds. */
export function anchorFor(path: string, line: number): Anchor {
  const pr = fixturePullRequest("auth-refactor", 1);
  if (pr === null) throw new Error("missing fixture");
  const target = anchorTargets(pr).get(path);
  if (target === undefined) throw new Error(`no target for ${path}`);
  const anchor = createAnchor(target, line);
  if (anchor === null) throw new Error(`no line ${line} in ${path}`);
  return anchor;
}

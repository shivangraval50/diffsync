export { PrDO } from "./PrDO.js";

interface Env {
  PRS: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/prs\/([A-Za-z0-9_-]+)\/(source|refresh|ws|ai)$/u.exec(url.pathname);
    if (match === null) return new Response("not found", { status: 404 });

    // The key IS the object name: one Durable Object per pull request, and
    // `encodePrKey` guarantees two different pull requests cannot produce the
    // same key (see packages/protocol/src/prkey.ts).
    const id = env.PRS.idFromName(match[1]!);
    return env.PRS.get(id).fetch(request);
  },
};

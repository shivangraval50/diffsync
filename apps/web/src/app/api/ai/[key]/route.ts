import { runAiPass } from "@diffsync/ai";
import { aiPassSchema, type AiPass } from "@diffsync/protocol";
import { LlmConfigError, selectProvider } from "@openbid/llm";
import { fetchSource, prsBaseUrl } from "@/lib/prs";

/**
 * The Durable Object's cached pass, if any. Parsed through the shared schema
 * rather than cast: this crosses the same Vercel-to-Cloudflare boundary
 * `fetchSource` does, and a stale or hand-edited cache row is exactly as
 * plausible as a version-skewed `/source` payload.
 */
async function cached(key: string): Promise<AiPass | null> {
  try {
    const res = await fetch(`${prsBaseUrl()}/prs/${key}/ai`, { cache: "no-store" });
    if (!res.ok) return null;
    const parsed = aiPassSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string }> }
): Promise<Response> {
  const { key } = await params;

  const hit = await cached(key);
  // Cached per pull request, not re-run on every view: the free tiers this
  // project runs on would not survive one model call per page load.
  if (hit !== null) return Response.json({ pass: hit });

  let provider;
  try {
    provider = selectProvider({
      LLM_PROVIDER: process.env.LLM_PROVIDER,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    });
  } catch (error) {
    // LlmConfigError specifically: nothing is configured, which is a supported
    // deployment rather than a fault. Anything else is re-thrown, so a genuine
    // bug is not swallowed by the same branch.
    if (error instanceof LlmConfigError) return Response.json({ pass: null });
    throw error;
  }

  const source = await fetchSource(key);
  if (source === null) return Response.json({ pass: null });

  const pass = await runAiPass(provider, source.pr, Date.now());
  if (pass === null) return Response.json({ pass: null });

  try {
    await fetch(`${prsBaseUrl()}/prs/${key}/ai`, { method: "PUT", body: JSON.stringify(pass) });
  } catch {
    // A cache write that fails costs one extra model call later, nothing more.
  }

  return Response.json({ pass });
}

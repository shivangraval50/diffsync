import type { CompletionRequest, LlmProvider } from "@openbid/llm";
import type { PullRequest } from "@diffsync/diff";
import { aiPassSchema, type AiPass } from "@diffsync/protocol";

export interface AiInput {
  title: string;
  files: {
    path: string;
    hunks: { heading: string; added: number; removed: number; sample: string }[];
  }[];
}

/** How many lines of each hunk go into the prompt: enough to characterise a
 *  change, small enough that a large pull request still fits one call. */
const SAMPLE_LINES = 12;
const MAX_TOKENS = 1024;

export function buildAiInput(pr: PullRequest): AiInput {
  return {
    title: pr.title,
    files: pr.files.flatMap((file) =>
      // A file with no diff is a file there is nothing to say about, and
      // listing it would invite the model to invent something.
      file.kind === "omitted"
        ? []
        : [
            {
              path: file.path,
              hunks: file.hunks.map((hunk) => ({
                heading: hunk.heading,
                added: hunk.lines.filter((l) => l.kind === "added").length,
                removed: hunk.lines.filter((l) => l.kind === "removed").length,
                sample: hunk.lines
                  .slice(0, SAMPLE_LINES)
                  .map(
                    (l) =>
                      `${l.kind === "added" ? "+" : l.kind === "removed" ? "-" : " "}${l.text}`
                  )
                  .join("\n"),
              })),
            },
          ]
    ),
  };
}

export const AI_SYSTEM = [
  "You summarise pull requests for human reviewers.",
  "Reply with JSON only, no prose and no code fence, matching exactly:",
  '{"summary": string, "flags": [{"path": string, "hunkIndex": number, "reason": string}]}',
  "summary is 2 to 3 plain sentences describing what changed and why it might matter.",
  "flags ranks the hunks worth reading first, at most five, each with a one-line reason.",
  "Use only file paths that appear in the input. Never invent one.",
  "You are suggesting a reading order, not reporting defects.",
].join("\n");

export function buildRequest(input: AiInput): CompletionRequest {
  const body = input.files
    .map((file) =>
      file.hunks
        .map(
          (hunk, index) =>
            `FILE ${file.path} HUNK ${index} (+${hunk.added}/-${hunk.removed}) ${hunk.heading}\n${hunk.sample}`
        )
        .join("\n\n")
    )
    .join("\n\n");

  return {
    system: AI_SYSTEM,
    prompt: `Pull request title: ${input.title}\n\n${body}`,
    maxTokens: MAX_TOKENS,
  };
}

function stripFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/u.exec(text);
  return fenced?.[1] ?? text;
}

/**
 * Turn a completion into a pass, or `null` when it cannot be used.
 *
 * Flags naming a file that is not in this pull request are dropped rather than
 * failing the whole pass: a hallucinated path rendered beside the diff would
 * read as a claim about this review, and the summary is still worth showing.
 *
 * The reply is untrusted model output, not a value this process produced --
 * it is parsed with `aiPassSchema.safeParse`, never cast. A shape change on
 * the provider side, or a 200 wrapping an error body, fails `safeParse` and
 * returns `null` here instead of sending `undefined` fields into the UI.
 */
export function parseAiOutput(
  text: string,
  opts: { generatedBy: string; generatedAtMs: number; knownPaths: ReadonlySet<string> }
): AiPass | null {
  const trimmed = stripFence(text).trim();
  // An empty completion is what @openbid/llm's Anthropic adapter returns for a
  // refusal: HTTP 200, stop_reason "refusal", no content.
  if (trimmed === "") return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const parsed = aiPassSchema.omit({ generatedBy: true, generatedAtMs: true }).safeParse(raw);
  if (!parsed.success) return null;

  return {
    summary: parsed.data.summary,
    flags: parsed.data.flags.filter((flag) => opts.knownPaths.has(flag.path)),
    generatedBy: opts.generatedBy,
    generatedAtMs: opts.generatedAtMs,
  };
}

/**
 * One call per pull request. Any failure -- a thrown network error, a
 * malformed or refused reply -- degrades to `null` rather than propagating:
 * the AI pass is decoration on top of a review surface that must stay fully
 * usable without it.
 */
export async function runAiPass(
  provider: LlmProvider,
  pr: PullRequest,
  nowMs: number
): Promise<AiPass | null> {
  try {
    const text = await provider.complete(buildRequest(buildAiInput(pr)));
    return parseAiOutput(text, {
      generatedBy: provider.name,
      generatedAtMs: nowMs,
      knownPaths: new Set(pr.files.map((f) => f.path)),
    });
  } catch {
    // The AI pass is decoration. Nothing it does may break a review.
    return null;
  }
}

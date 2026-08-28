"use server";

import { revalidatePath } from "next/cache";
import { refreshSource } from "@/lib/prs";

/**
 * Re-resolve a pull request's source. For a seeded sample, `nextRevision` moves
 * to the next committed revision, which is how a force-push is demonstrated
 * without anyone having to force-push. For a GitHub pull request it is null and
 * the current head is re-fetched.
 *
 * The revision comes from the form, not from decoding the key: after one
 * refresh the key still names revision 1 while the Durable Object holds a later
 * one, so re-deriving it from the key would advance to the same revision twice.
 */
export async function refreshPr(formData: FormData): Promise<void> {
  const key = String(formData.get("key") ?? "");
  if (key === "") return;
  const raw = formData.get("nextRevision");
  const nextRevision = typeof raw === "string" && raw !== "" ? Number(raw) : null;
  await refreshSource(key, nextRevision);
  revalidatePath(`/pr/${key}`);
}

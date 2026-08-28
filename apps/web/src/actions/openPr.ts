"use server";

import { redirect } from "next/navigation";
import { encodePrKey } from "@diffsync/protocol";
import { parsePrUrl } from "@/lib/prUrl";

export async function openPr(formData: FormData): Promise<void> {
  const raw = String(formData.get("url") ?? "");
  const ref = parsePrUrl(raw);
  // `redirect` throws internally, so this is a terminal branch, not a
  // fall-through: an unparseable paste returns to the home page with an
  // explanation rather than opening a Durable Object for a key nobody meant.
  if (ref === null) redirect("/?error=url");
  redirect(`/pr/${encodePrKey(ref)}`);
}

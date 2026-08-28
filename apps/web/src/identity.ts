import { cookies } from "next/headers";
import { NICKNAME_MAX_LENGTH } from "@diffsync/protocol";
import { auth } from "./auth";
import { generateGuestNickname } from "./nickname";

export { generateGuestNickname };

const GUEST_COOKIE = "diffsync_guest";

/**
 * Truncate to `maxLength` UTF-16 units without ever splitting a character.
 *
 * `slice` cuts by UTF-16 unit, so a name with an emoji straddling the boundary
 * comes back with a lone surrogate: malformed, renders as U+FFFD, and still
 * passes `.max(NICKNAME_MAX_LENGTH)` because a lone surrogate counts as one
 * unit. Taking the first `maxLength` CODE POINTS instead can overshoot the
 * wire cap by one unit whenever a surrogate-pair character is among them, and
 * then fails the very schema this exists to satisfy. Iterating by code point
 * while budgeting in UTF-16 units avoids both: a character that would only
 * partly fit is dropped whole.
 */
function truncateToCodePoints(value: string, maxLength: number): string {
  let result = "";
  for (const ch of value) {
    if (result.length + ch.length > maxLength) break;
    result += ch;
  }
  return result;
}

/**
 * BOTH branches truncate. Neither source is trustworthy: a GitHub display name
 * can be any length, and the guest cookie is client-writable. This function is
 * the only length gate between either of them and the wire.
 *
 * Deliberately never calls `cookies().set()`: Next does not support setting
 * cookies during Server Component rendering, and this runs from one. `proxy.ts`
 * assigns the cookie; this only ever reads it.
 */
export async function resolveIdentity(): Promise<{ nickname: string; persistent: boolean }> {
  const session = await auth();
  const name = session?.user?.name;
  if (typeof name === "string" && name.length > 0) {
    return { nickname: truncateToCodePoints(name, NICKNAME_MAX_LENGTH), persistent: true };
  }

  const jar = await cookies();
  const existing = jar.get(GUEST_COOKIE)?.value;
  if (existing) {
    return {
      nickname: truncateToCodePoints(existing, NICKNAME_MAX_LENGTH),
      persistent: false,
    };
  }

  return { nickname: generateGuestNickname(), persistent: false };
}

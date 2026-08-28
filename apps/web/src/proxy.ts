import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { generateGuestNickname } from "@/nickname";

const GUEST_COOKIE = "diffsync_guest";

/**
 * Assign a guest identity on a visitor's first request. This exists because
 * Next does not support setting cookies during Server Component rendering --
 * only in a Server Function, a Route Handler, or here.
 *
 * Rewrites the REQUEST's own cookie header as well as setting the response
 * cookie, so the new name is visible to `cookies().get()` during this same
 * render. Without that, the first page a guest sees names them differently
 * from the cookie that was just saved.
 */
export function proxy(request: NextRequest): NextResponse {
  if (request.cookies.has(GUEST_COOKIE)) return NextResponse.next();

  const nickname = generateGuestNickname();
  const headers = new Headers(request.headers);
  const existing = headers.get("cookie");
  headers.set("cookie", existing ? `${existing}; ${GUEST_COOKIE}=${nickname}` : `${GUEST_COOKIE}=${nickname}`);

  const response = NextResponse.next({ request: { headers } });
  response.cookies.set(GUEST_COOKIE, nickname, { httpOnly: false, sameSite: "lax", path: "/" });
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

import NextAuth from "next-auth";
import type { JWT } from "next-auth/jwt";
import type { Profile } from "next-auth";
import GitHub from "next-auth/providers/github";

/**
 * Capture GitHub's globally unique `login` onto the token. `profile` is only
 * present on the sign-in request itself, so it has to be captured now rather
 * than read fresh later. Exported separately so it is unit-testable without a
 * real OAuth exchange.
 */
export async function jwt({
  token,
  profile,
}: {
  token: JWT;
  profile?: Profile;
}): Promise<JWT> {
  const login = profile?.login;
  if (typeof login === "string" && login.length > 0) token.name = login;
  return token;
}

/** JWT sessions: no database adapter, so no paid storage tier and nothing
 *  about identity is written to Neon. */
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub],
  session: { strategy: "jwt" },
  callbacks: { jwt },
});

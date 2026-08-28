import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

describe("proxy", () => {
  it("assigns a guest cookie on a first visit", () => {
    const response = proxy(new NextRequest("https://diffsync.test/"));
    const cookie = response.cookies.get("diffsync_guest");
    expect(cookie?.value).toMatch(/^[a-z]+-[a-z]+-[0-9a-z]{3}$/u);
    // Readable by the client, which is what makes it untrusted input that
    // identity.ts has to truncate.
    expect(cookie?.httpOnly).toBe(false);
  });

  it("makes the new cookie visible to the SAME request's render", () => {
    // Otherwise the very first page a guest sees shows a different name from
    // the one saved to their browser, and the socket connects under a third.
    const response = proxy(new NextRequest("https://diffsync.test/"));
    const forwarded = response.headers.get("x-middleware-request-cookie");
    const assigned = response.cookies.get("diffsync_guest")?.value ?? "";
    expect(assigned).not.toBe("");
    expect(forwarded ?? "").toContain(assigned);
  });

  it("leaves an existing cookie alone", () => {
    const request = new NextRequest("https://diffsync.test/");
    request.cookies.set("diffsync_guest", "brisk-otter-7f3");
    const response = proxy(request);
    expect(response.cookies.get("diffsync_guest")).toBeUndefined();
  });
});

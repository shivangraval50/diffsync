import { test, expect } from "@playwright/test";

/**
 * A distinct review per test in this file: both tests advance the sample to
 * revision 2, so sharing one Durable Object would make whichever ran second
 * start from a revision that has no "Fetch new head" button left.
 * Mirrors `encodePrKey`: base64url of `<nonce>/fx/<slug>/<revision>`.
 */
function samplePath(nonce: string): string {
  const key = Buffer.from(`${nonce}/fx/auth-refactor/1`).toString("base64url");
  return `/pr/${key}`;
}

test("a force-push relocates one thread and outdates another, and says which", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(samplePath(`e2epush${Date.now().toString(36)}`));
  await expect(page.getByRole("heading", { name: /session issuance/iu })).toBeVisible();

  // Thread A: on a line the force-push only moves.
  await page.getByTestId("anchor-src/auth/session.ts-15").click();
  await page.getByLabel(/your comment/iu).fill("This should survive the push.");
  await page.getByRole("button", { name: /^comment$/iu }).click();
  await expect(page.getByText("This should survive the push.")).toBeVisible();

  // Thread B: on a line the force-push rewrites.
  await page.getByTestId("anchor-src/auth/token.ts-5").click();
  await page.getByLabel(/your comment/iu).fill("This code is about to vanish.");
  await page.getByRole("button", { name: /^comment$/iu }).click();
  await expect(page.getByText("This code is about to vanish.")).toBeVisible();

  const headBefore = await page.getByTestId("head-sha").innerText();

  await page.getByRole("button", { name: /fetch new head/iu }).click();
  await expect(page.getByTestId("head-sha")).not.toHaveText(headBefore);

  // Thread A followed its code from line 15 to line 18. Asserted by its
  // position in the diff, not merely by still being on the page: a thread
  // rendered at its old line number would pass a "still visible" check while
  // pointing at different code, which is the exact defect this project is
  // about.
  const relocatedRow = page.getByTestId("line-src/auth/session.ts-18");
  await expect(relocatedRow).toBeVisible();
  // `renderBelow`'s output is a sibling of the row inside the same wrapper
  // element (see DiffFileView in Task 14), so the wrapper is the scope that
  // ties this comment to line 18 specifically -- rather than to the page,
  // which a thread rendered at its old line number would also satisfy.
  await expect(relocatedRow.locator("..")).toContainText("This should survive the push.");
  // NOTE ON A BRIEF DEFECT: the task brief asserted
  // `getByTestId("line-src/auth/session.ts-15")` has count 0 here. That row
  // does NOT disappear: the force-push inserts a guard clause ABOVE the
  // anchored region, so every line number from 15 down shifts by three, and
  // line 15 in revision 2 is real, unrelated code
  // (`const now = Date.now();`, verified against the actual fixture output).
  // Asserting the row's absence would fail on a fully correct
  // implementation. The real invariant -- that thread A's comment does not
  // ALSO render at its old position, which is what a silent mis-anchor to
  // the wrong line would produce -- is what this checks instead.
  await expect(page.getByTestId("line-src/auth/session.ts-15").locator("..")).not.toContainText(
    "This should survive the push."
  );

  // Thread B is detached, named, and quoting the code it was written about.
  const outdated = page.getByTestId("outdated-panel");
  await expect(outdated).toBeVisible();
  await expect(outdated).toContainText("This code is about to vanish.");
  await expect(outdated).toContainText("src/auth/token.ts:5");
  await expect(outdated).toContainText("const body = encode({ ...payload, iat: Date.now() });");

  // Same brief defect as above, mirrored for the outdated thread: line 5 of
  // token.ts still exists in revision 2 (rewritten to
  // `const body = encodeCompact(payload, { iat: now() });`), so the row
  // itself is expected to be present. The invariant that actually matters --
  // thread B's comment must NOT be sitting inline on that row pretending to
  // be current, only detached in the outdated panel -- is what this checks.
  await expect(page.getByTestId("line-src/auth/token.ts-5").locator("..")).not.toContainText(
    "This code is about to vanish."
  );
});

test("the other reviewer is told the source changed", async ({ browser }) => {
  const path = samplePath(`e2etold${Date.now().toString(36)}`);
  const one = await browser.newContext().then((c) => c.newPage());
  await one.goto(path);
  const two = await browser.newContext().then((c) => c.newPage());
  await two.goto(path);
  await expect(two.getByRole("heading", { name: /session issuance/iu })).toBeVisible();

  const headBefore = await two.getByTestId("head-sha").innerText();
  await one.getByRole("button", { name: /fetch new head/iu }).click();

  // The second reviewer's page refreshes itself on the sourceChanged frame.
  // Without this, half the room would keep commenting against a revision that
  // no longer exists and every one of those comments would be rejected.
  await expect(two.getByTestId("head-sha")).not.toHaveText(headBefore);
});

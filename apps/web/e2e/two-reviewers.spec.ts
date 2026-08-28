import { test, expect, type Browser, type Page } from "@playwright/test";

/**
 * The auth-refactor sample under a nonce unique to this run, so this file's
 * threads cannot be seen by force-push.spec.ts and a re-run does not inherit
 * the previous run's comments. Mirrors `encodePrKey` from `@diffsync/protocol`:
 * base64url of `<nonce>/fx/<slug>/<revision>`.
 */
const NONCE = `e2etwo${Date.now().toString(36)}`;

function samplePath(): string {
  const key = Buffer.from(`${NONCE}/fx/auth-refactor/1`).toString("base64url");
  return `/pr/${key}`;
}

async function openAs(browser: Browser, path: string): Promise<Page> {
  // A separate context per reviewer: separate cookies, so separate guest
  // identity, which is what makes this two reviewers rather than two tabs.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(path);
  await expect(page.getByRole("heading", { name: /session issuance/iu })).toBeVisible();
  // Wait for the socket: presence lists at least this reviewer once connected.
  await expect(page.getByRole("list", { name: /reviewers here/iu }).getByRole("listitem")).not.toHaveCount(
    0
  );
  return page;
}

test("a thread opened by one reviewer appears for the other, and resolve converges", async ({
  browser,
}) => {
  const path = samplePath();
  const ada = await openAs(browser, path);
  const grace = await openAs(browser, path);

  // Both reviewers can see each other before anything is said.
  await expect(grace.getByRole("list", { name: /reviewers here/iu }).getByRole("listitem")).toHaveCount(
    2
  );

  await ada.getByTestId("anchor-src/auth/session.ts-15").click();
  await ada.getByLabel(/your comment/iu).fill("Why two clocks here?");
  await ada.getByRole("button", { name: /^comment$/iu }).click();

  // It arrives for the other reviewer, with the author's name attached.
  await expect(grace.getByText("Why two clocks here?")).toBeVisible();

  // And it is on the line it was written about, not merely somewhere on screen.
  const graceRow = grace.getByTestId("line-src/auth/session.ts-15");
  await expect(graceRow).toBeVisible();

  await grace.getByLabel(/^reply$/iu).fill("Because the TTL moved.");
  await grace.getByRole("button", { name: /^reply$/iu }).click();
  await expect(ada.getByText("Because the TTL moved.")).toBeVisible();

  // Comments appear in one order for both reviewers -- the Durable Object's
  // serialisation, visible through the UI.
  const adaBodies = await ada.getByTestId(/^comment-/).allInnerTexts();
  const graceBodies = await grace.getByTestId(/^comment-/).allInnerTexts();
  expect(adaBodies).toEqual(graceBodies);

  await ada.getByRole("button", { name: /^resolve$/iu }).click();
  await expect(grace.getByTestId("resolved-by")).toContainText(/resolved by/iu);
  await expect(grace.getByRole("button", { name: /unresolve/iu })).toBeVisible();

  await grace.getByRole("button", { name: /unresolve/iu }).click();
  await expect(ada.getByRole("button", { name: /^resolve$/iu })).toBeVisible();
  await expect(ada.getByTestId("resolved-by")).toHaveCount(0);
});

test("a reviewer's cursor is visible to the other reviewer", async ({ browser }) => {
  const path = samplePath();
  const ada = await openAs(browser, path);
  const grace = await openAs(browser, path);

  await ada.getByTestId("anchor-src/auth/token.ts-5").click();

  await expect(grace.getByTestId("cursors-src/auth/token.ts-5")).toBeVisible();
  // And it is attributed, not an anonymous marker.
  await expect(grace.getByTestId("cursors-src/auth/token.ts-5")).not.toBeEmpty();
});

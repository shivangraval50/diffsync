import Link from "next/link";
import { listFixtures } from "@diffsync/fixtures";
import { encodePrKey } from "@diffsync/protocol";
import { openPr } from "@/actions/openPr";
import { recentPrs } from "@/lib/recent";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}): Promise<React.JSX.Element> {
  const { error } = await searchParams;
  const recent = await recentPrs();

  return (
    <main>
      <h1>diffsync</h1>
      <p>Review a pull request with other people, on the same diff, at the same time.</p>

      <form action={openPr}>
        <label htmlFor="url">GitHub pull request URL</label>
        <input id="url" name="url" placeholder="https://github.com/owner/repo/pull/123" />
        <button type="submit">Open it</button>
      </form>
      {error === "url" ? (
        <p role="alert">That does not look like a GitHub pull request URL.</p>
      ) : null}

      <h2>Or review a sample</h2>
      <ul>
        {listFixtures().map((fixture) => (
          <li key={fixture.slug}>
            <Link href={`/pr/${encodePrKey({ kind: "fixture", slug: fixture.slug, revision: 1 })}`}>
              {fixture.title}
            </Link>
            <span>{fixture.blurb}</span>
          </li>
        ))}
      </ul>

      {recent.length > 0 ? (
        <>
          <h2>Recently reviewed</h2>
          <ul>
            {recent.map((pr) => (
              <li key={pr.prKey}>
                <Link href={`/pr/${pr.prKey}`}>{pr.label}</Link> {pr.title}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </main>
  );
}

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
    <main className="home">
      <h1 className="home__title">diffsync</h1>
      <p className="home__lead">
        Review a pull request with other people, on the same diff, at the same time.
      </p>

      <form action={openPr} className="home__form">
        <label htmlFor="url" className="label">
          GitHub pull request URL
        </label>
        <input
          id="url"
          name="url"
          className="field"
          placeholder="https://github.com/owner/repo/pull/123"
        />
        <button type="submit" className="btn btn--primary">
          Open it
        </button>
      </form>
      {error === "url" ? (
        <p role="alert" className="notice notice--error">
          That does not look like a GitHub pull request URL.
        </p>
      ) : null}

      <h2 className="home__section-title">Or review a sample</h2>
      {/* `role="list"` restated because `list-style: none` drops list
          semantics in Safari; the role keeps the markup and the
          accessibility tree saying the same thing. */}
      <ul role="list" className="sample-list">
        {listFixtures().map((fixture) => (
          <li key={fixture.slug} className="sample">
            <Link
              className="sample__link"
              href={`/pr/${encodePrKey({ kind: "fixture", slug: fixture.slug, revision: 1 })}`}
            >
              {fixture.title}
            </Link>
            <span className="sample__blurb">{fixture.blurb}</span>
          </li>
        ))}
      </ul>

      {recent.length > 0 ? (
        <>
          <h2 className="home__section-title">Recently reviewed</h2>
          <ul role="list" className="recent-list">
            {recent.map((pr) => (
              <li key={pr.prKey} className="recent">
                <Link href={`/pr/${pr.prKey}`}>{pr.label}</Link> {pr.title}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </main>
  );
}

import { notFound } from "next/navigation";
import { fixtureRevisionCount } from "@diffsync/fixtures";
import { prLabel } from "@diffsync/protocol";
import { RefreshButton } from "@/components/RefreshButton";
import { SourceBanner } from "@/components/SourceBanner";
import { resolveIdentity } from "@/identity";
import { fetchSource } from "@/lib/prs";
import { ReviewSurface } from "./ReviewSurface";

export default async function PrPage({
  params,
}: {
  params: Promise<{ key: string }>;
}): Promise<React.JSX.Element> {
  const { key } = await params;
  const source = await fetchSource(key);
  if (source === null) notFound();

  const identity = await resolveIdentity();

  return (
    <main>
      <header>
        <h1>{source.pr.title}</h1>
        <p data-testid="pr-label">{prLabel(source.pr.ref)}</p>
        <p data-testid="head-sha">{source.pr.headSha.slice(0, 7)}</p>
      </header>

      {source.pr.ref.kind === "fixture" ? (
        fixtureRevisionCount(source.pr.ref.slug) > source.pr.ref.revision ? (
          <RefreshButton
            prKey={key}
            nextRevision={source.pr.ref.revision + 1}
            label="Fetch new head (simulates a force-push)"
          />
        ) : null
      ) : (
        <RefreshButton prKey={key} nextRevision={null} label="Fetch new head" />
      )}

      <SourceBanner source={source} />

      <ReviewSurface
        prKey={key}
        source={source}
        nickname={identity.nickname}
        persistent={identity.persistent}
      />
    </main>
  );
}

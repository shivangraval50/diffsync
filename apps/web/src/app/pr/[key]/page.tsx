import { notFound } from "next/navigation";
import { prLabel } from "@diffsync/protocol";
import { SourceBanner } from "@/components/SourceBanner";
import { DiffPanelHost } from "@/components/DiffPanelHost";
import { fetchSource } from "@/lib/prs";

export default async function PrPage({
  params,
}: {
  params: Promise<{ key: string }>;
}): Promise<React.JSX.Element> {
  const { key } = await params;
  const source = await fetchSource(key);
  if (source === null) notFound();

  return (
    <main>
      <header>
        <h1>{source.pr.title}</h1>
        <p data-testid="pr-label">{prLabel(source.pr.ref)}</p>
        <p data-testid="head-sha">{source.pr.headSha.slice(0, 7)}</p>
      </header>

      <SourceBanner source={source} />

      <DiffPanelHost files={source.pr.files} />
    </main>
  );
}

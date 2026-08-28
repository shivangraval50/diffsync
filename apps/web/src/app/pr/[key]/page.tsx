import { notFound } from "next/navigation";
import { prLabel } from "@diffsync/protocol";
import { SourceBanner } from "@/components/SourceBanner";
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

      <ol data-testid="file-list">
        {source.pr.files.map((file) => (
          <li key={file.path} data-testid={`file-${file.path}`}>
            <span>{file.path}</span>
            <span>{file.status}</span>
            <span>
              {file.kind === "patch"
                ? `${file.hunks.length} hunk${file.hunks.length === 1 ? "" : "s"}`
                : "diff not shown"}
            </span>
          </li>
        ))}
      </ol>
    </main>
  );
}

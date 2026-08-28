import { refreshPr } from "@/actions/refresh";

export function RefreshButton({
  prKey,
  nextRevision,
  label,
}: {
  prKey: string;
  /** The fixture revision to move to, or null for a GitHub re-fetch. */
  nextRevision: number | null;
  label: string;
}): React.JSX.Element {
  return (
    <form action={refreshPr}>
      <input type="hidden" name="key" value={prKey} />
      <input type="hidden" name="nextRevision" value={nextRevision === null ? "" : nextRevision} />
      <button type="submit">{label}</button>
    </form>
  );
}

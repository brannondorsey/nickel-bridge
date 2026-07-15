/** Solid ink HCP pill. Keeps the .hcp-badge class the smoke test selects on. */
export function HcpBadge({ hcp }: { hcp: number }) {
  return <span className="hcp-badge num">{hcp} HCP</span>;
}

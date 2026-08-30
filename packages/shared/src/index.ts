/** "2h 30m" style countdown to a reset timestamp, shared by the CLI and the dashboard. */
export function formatCountdown(resetsAt: number | null | undefined, zeroLabel = "now"): string {
  if (!resetsAt) return "unknown";
  const ms = resetsAt - Date.now();
  if (ms <= 0) return zeroLabel;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** GETs and parses JSON, throwing on a non-2xx response. */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`request failed: ${res.status} ${url}`);
  return res.json() as Promise<T>;
}

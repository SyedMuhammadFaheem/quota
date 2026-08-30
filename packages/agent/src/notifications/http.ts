/** POSTs to a notification provider, swallowing network errors (returns false rather than throwing). */
export async function postNotification(url: string, init: RequestInit): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "POST", ...init });
    return res.ok;
  } catch {
    return false;
  }
}

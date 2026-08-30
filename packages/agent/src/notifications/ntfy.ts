export interface NtfyConfig {
  topic: string;
  server?: string;
}

export async function sendNtfy(config: NtfyConfig, message: string): Promise<boolean> {
  const server = config.server?.replace(/\/$/, "") ?? "https://ntfy.sh";
  const res = await fetch(`${server}/${config.topic}`, {
    method: "POST",
    body: message,
    headers: { title: "Claude Quota" },
  });
  return res.ok;
}

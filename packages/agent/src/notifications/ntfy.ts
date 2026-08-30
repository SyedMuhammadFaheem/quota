import { postNotification } from "./http.ts";

export interface NtfyConfig {
  topic: string;
  server?: string;
}

export async function sendNtfy(config: NtfyConfig, message: string): Promise<boolean> {
  const server = config.server?.replace(/\/$/, "") ?? "https://ntfy.sh";
  return postNotification(`${server}/${config.topic}`, {
    body: message,
    headers: { title: "Claude Quota" },
  });
}

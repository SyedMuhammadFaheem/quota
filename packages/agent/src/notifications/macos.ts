import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function escapeForAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function sendMacNotification(message: string, title = "Claude Quota"): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const script = `display notification "${escapeForAppleScript(message)}" with title "${escapeForAppleScript(title)}"`;
  try {
    await execFileAsync("osascript", ["-e", script]);
    return true;
  } catch {
    return false;
  }
}

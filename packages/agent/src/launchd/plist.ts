import os from "node:os";
import path from "node:path";

export const LABEL = "com.quota.agent";

export function plistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

export function logDir(): string {
  return path.join(os.homedir(), ".quota", "logs");
}

export function generatePlist(nodePath: string, entryScript: string): string {
  const out = path.join(logDir(), "agent.out.log");
  const err = path.join(logDir(), "agent.err.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${entryScript}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${out}</string>
  <key>StandardErrorPath</key>
  <string>${err}</string>
</dict>
</plist>
`;
}

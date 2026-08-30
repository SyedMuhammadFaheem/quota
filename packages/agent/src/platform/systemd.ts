import os from "node:os";
import path from "node:path";

export const UNIT_NAME = "quota-agent.service";

export function unitPath(): string {
  return path.join(os.homedir(), ".config", "systemd", "user", UNIT_NAME);
}

export function generateUnit(nodePath: string, entryScript: string): string {
  return `[Unit]
Description=Claude Quota agent

[Service]
ExecStart=${nodePath} ${entryScript}
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

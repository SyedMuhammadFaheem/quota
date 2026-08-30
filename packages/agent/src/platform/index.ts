import * as macos from "./macos.ts";
import * as linux from "./linux.ts";
import * as windows from "./windows.ts";
import type { AutostartResult } from "./types.ts";

export type { AutostartResult } from "./types.ts";

interface PlatformAdapter {
  sendNotification(title: string, message: string): Promise<boolean>;
  isAutostartInstalled(): boolean;
  installAutostart(nodePath: string, entryScript: string): AutostartResult;
  startAutostart(nodePath: string, entryScript: string): AutostartResult;
  stopAutostart(): AutostartResult;
}

/** The one place that maps `process.platform` to a concrete implementation. */
export const adapters: Partial<Record<NodeJS.Platform, PlatformAdapter>> = {
  darwin: {
    sendNotification: macos.sendNotification,
    isAutostartInstalled: macos.isAutostartInstalled,
    installAutostart: macos.installAutostart,
    startAutostart: () => macos.startAutostart(),
    stopAutostart: () => macos.stopAutostart(),
  },
  linux: {
    sendNotification: linux.sendNotification,
    isAutostartInstalled: linux.isAutostartInstalled,
    installAutostart: linux.installAutostart,
    startAutostart: () => linux.startAutostart(),
    stopAutostart: () => linux.stopAutostart(),
  },
  win32: {
    sendNotification: windows.sendNotification,
    isAutostartInstalled: windows.isAutostartInstalled,
    installAutostart: windows.installAutostart,
    startAutostart: windows.startAutostart,
    stopAutostart: () => windows.stopAutostart(),
  },
};

const UNSUPPORTED = (platform: string): AutostartResult => ({
  ok: false,
  message: `No autostart support for platform "${platform}" yet. Start the agent manually with "quota start" whenever you need it.`,
});

export async function sendNativeNotification(
  title: string,
  message: string,
  platform: NodeJS.Platform = process.platform,
  registry: Partial<Record<NodeJS.Platform, PlatformAdapter>> = adapters,
): Promise<boolean> {
  const adapter = registry[platform];
  if (!adapter) return false;
  try {
    return await adapter.sendNotification(title, message);
  } catch {
    return false;
  }
}

export function isAutostartInstalled(
  platform: NodeJS.Platform = process.platform,
  registry: Partial<Record<NodeJS.Platform, PlatformAdapter>> = adapters,
): boolean {
  return registry[platform]?.isAutostartInstalled() ?? false;
}

export function installAutostart(
  nodePath: string,
  entryScript: string,
  platform: NodeJS.Platform = process.platform,
  registry: Partial<Record<NodeJS.Platform, PlatformAdapter>> = adapters,
): AutostartResult {
  const adapter = registry[platform];
  return adapter ? adapter.installAutostart(nodePath, entryScript) : UNSUPPORTED(platform);
}

export function startAutostart(
  nodePath: string,
  entryScript: string,
  platform: NodeJS.Platform = process.platform,
  registry: Partial<Record<NodeJS.Platform, PlatformAdapter>> = adapters,
): AutostartResult {
  const adapter = registry[platform];
  return adapter ? adapter.startAutostart(nodePath, entryScript) : UNSUPPORTED(platform);
}

export function stopAutostart(
  platform: NodeJS.Platform = process.platform,
  registry: Partial<Record<NodeJS.Platform, PlatformAdapter>> = adapters,
): AutostartResult {
  const adapter = registry[platform];
  return adapter ? adapter.stopAutostart() : UNSUPPORTED(platform);
}

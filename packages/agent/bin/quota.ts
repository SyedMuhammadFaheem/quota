#!/usr/bin/env node
import { buildCli } from "../src/cli/index.ts";
import { startAgent } from "../src/index.ts";

// launchd invokes this same file directly (no subcommand) to run the daemon in the foreground.
if (process.argv.length <= 2) {
  startAgent();
} else {
  buildCli().parse(process.argv);
}

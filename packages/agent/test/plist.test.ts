import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePlist, LABEL } from "../src/launchd/plist.ts";

test("generatePlist embeds the label, node path, and entry script", () => {
  const xml = generatePlist("/usr/local/bin/node", "/path/to/agent-entry.ts");
  assert.match(xml, new RegExp(`<string>${LABEL}</string>`));
  assert.match(xml, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(xml, /<string>\/path\/to\/agent-entry\.ts<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
});

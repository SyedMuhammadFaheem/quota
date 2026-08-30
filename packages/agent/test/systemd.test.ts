import { test } from "node:test";
import assert from "node:assert/strict";
import { generateUnit, UNIT_NAME } from "../src/platform/systemd.ts";

test("generateUnit embeds the node path and entry script, and enables user-level restart", () => {
  const unit = generateUnit("/usr/bin/node", "/path/to/agent-entry.ts");
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/path\/to\/agent-entry\.ts/);
  assert.match(unit, /WantedBy=default\.target/);
  assert.match(unit, /Restart=on-failure/);
  assert.equal(UNIT_NAME, "quota-agent.service");
});

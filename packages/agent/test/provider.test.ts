import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatusLinePayload } from "../src/provider/statusline-hook.ts";
import { parseOauthUsageResponse } from "../src/provider/oauth-fallback.ts";

test("statusline payload with rate_limits parses both windows", () => {
  const snapshot = parseStatusLinePayload({
    rate_limits: {
      five_hour: { utilization: 42, resets_at: 1700000000 },
      seven_day: { utilization: 10, resets_at: "2024-01-01T00:00:00Z" },
    },
  });
  assert.ok(snapshot);
  assert.equal(snapshot!.source, "statusline");
  assert.equal(snapshot!.windows.length, 2);
  const fiveHour = snapshot!.windows.find((w) => w.kind === "five_hour")!;
  assert.equal(fiveHour.utilization, 42);
  assert.equal(fiveHour.resetsAt, 1700000000 * 1000);
});

test("statusline payload without rate_limits (older Claude Code) yields undefined", () => {
  const snapshot = parseStatusLinePayload({ model: "sonnet" });
  assert.equal(snapshot, undefined);
});

test("statusline payload missing resets_at still captures utilization", () => {
  const snapshot = parseStatusLinePayload({
    rate_limits: { five_hour: { utilization: 5 } },
  });
  assert.equal(snapshot!.windows[0].resetsAt, undefined);
});

test("oauth usage response parses into snapshot", () => {
  const snapshot = parseOauthUsageResponse({
    five_hour: { utilization: 77, resets_at: 1700000000 },
  });
  assert.ok(snapshot);
  assert.equal(snapshot!.source, "oauth_api");
  assert.equal(snapshot!.windows[0].utilization, 77);
});

test("empty oauth usage response yields undefined", () => {
  assert.equal(parseOauthUsageResponse({}), undefined);
});

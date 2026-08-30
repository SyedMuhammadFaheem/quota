import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSessionContext } from "../src/provider/session-context.ts";

test("Stop: extracts a status line from the first paragraph", () => {
  const update = extractSessionContext({
    hook_event_name: "Stop",
    last_assistant_message: "Fixed the Redis timeout bug by adding a retry with backoff.\n\nLet me know if you want tests too.",
  });
  assert.equal(update.statusText, "Fixed the Redis timeout bug by adding a retry with backoff.");
  assert.equal(update.nextTasks, undefined);
});

test("Stop: strips markdown formatting from the status line", () => {
  const update = extractSessionContext({
    hook_event_name: "Stop",
    last_assistant_message: "Implemented `parseUsage()` and **fixed** the [bug](https://example.com).",
  });
  assert.equal(update.statusText, "Implemented and fixed the bug.");
});

test("Stop: extracts a Next steps list", () => {
  const update = extractSessionContext({
    hook_event_name: "Stop",
    last_assistant_message: [
      "Implemented the Redis pattern profiler.",
      "",
      "Next steps:",
      "1. Fix authentication",
      "2. Add integration tests",
      "- Update README",
    ].join("\n"),
  });
  assert.deepEqual(update.nextTasks, ["Fix authentication", "Add integration tests", "Update README"]);
  assert.equal(update.statusText, "Implemented the Redis pattern profiler.");
});

test("Stop: caps next-task extraction at 5 items and stops at prose", () => {
  const message = [
    "Status update.",
    "",
    "TODO:",
    "1. one",
    "2. two",
    "3. three",
    "4. four",
    "5. five",
    "6. six",
  ].join("\n");
  const update = extractSessionContext({ hook_event_name: "Stop", last_assistant_message: message });
  assert.equal(update.nextTasks?.length, 5);
});

test("Stop: no next-steps section yields no nextTasks", () => {
  const update = extractSessionContext({
    hook_event_name: "Stop",
    last_assistant_message: "Just a plain response with no list.",
  });
  assert.equal(update.nextTasks, undefined);
});

test("Stop: missing or empty last_assistant_message yields nothing", () => {
  assert.deepEqual(extractSessionContext({ hook_event_name: "Stop" }), {});
  assert.deepEqual(extractSessionContext({ hook_event_name: "Stop", last_assistant_message: "   " }), {});
});

test("SessionEnd: produces an auto note tagged with the reason", () => {
  const update = extractSessionContext({ hook_event_name: "SessionEnd", reason: "logout" });
  assert.equal(update.note, "[auto] Session ended (logout)");
});

test("SessionEnd: defaults reason to 'other' when absent", () => {
  const update = extractSessionContext({ hook_event_name: "SessionEnd" });
  assert.equal(update.note, "[auto] Session ended (other)");
});

test("unknown hook_event_name yields nothing", () => {
  assert.deepEqual(extractSessionContext({ hook_event_name: "PreToolUse" }), {});
});

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { __test__ } from "../pi-extension/cohort-bridge.ts";

const { buildStatusAugmentation, trackLiveChild, resetForTest } = __test__;

function child(overrides: Partial<Parameters<typeof trackLiveChild>[0]> = {}) {
  return {
    childId: "9638e03c-1",
    name: "implementer",
    agent: "implementer",
    startTime: Date.now(),
    activityFile: "/nonexistent/activity.json",
    intercomSessionName: "subagent-implementer-9638e03c-1",
    ...overrides,
  };
}

describe("cohort-bridge status augmentation", () => {
  afterEach(() => {
    resetForTest();
  });

  it("returns undefined when no children are live", () => {
    assert.equal(buildStatusAugmentation({ action: "status" }, []), undefined);
  });

  it("lists live children for a session-wide status call", () => {
    trackLiveChild(child());
    const out = buildStatusAugmentation({ action: "status" }, [child()]);
    assert.ok(out, "augmentation produced");
    assert.match(out!, /cohort-bridge children \(this session\): 1/);
    assert.match(out!, /- subagent-implementer-9638e03c-1 \| running \| implementer/);
  });

  it("stays out of a targeted single-run lookup by id", () => {
    assert.equal(
      buildStatusAugmentation({ action: "status", id: "abc123" }, [child()]),
      undefined,
    );
  });

  it("ignores non-status actions", () => {
    assert.equal(buildStatusAugmentation({ action: "list" }, [child()]), undefined);
  });
});

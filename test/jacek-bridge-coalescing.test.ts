import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { __test__ } from "../pi-extension/jacek-bridge.ts";

const { deliverResult, resetForTest } = __test__;
// __test__.setOrphanSink is used directly in the torn-down-context test.

function createMockExtensionApi() {
  const sentMessages: Array<{ message: any; options?: any }> = [];
  return {
    sentMessages,
    api: {
      sendMessage(message: any, options?: any) {
        sentMessages.push({ message, options });
      },
    } as any,
  };
}

function createMockContext(idle = true) {
  let isIdleValue = idle;
  return {
    ctx: {
      isIdle: () => isIdleValue,
    } as any,
    setIdle(value: boolean) {
      isIdleValue = value;
    },
  };
}

function result(n: number) {
  return { customType: "subagent_result", content: `result ${n}`, details: { n } };
}

describe("jacek-bridge result coalescing", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
  });

  afterEach(() => {
    resetForTest();
    mock.timers.reset();
  });

  it("delivers a single result as a triggered steer", () => {
    const { api, sentMessages } = createMockExtensionApi();
    const { ctx } = createMockContext(true);

    deliverResult(api, ctx, result(1));
    mock.timers.tick(200);

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].message.content, "result 1");
    assert.deepEqual(sentMessages[0].options, { triggerTurn: true, deliverAs: "steer" });
  });

  it("coalesces results arriving within the flush window into one triggered turn", () => {
    const { api, sentMessages } = createMockExtensionApi();
    const { ctx } = createMockContext(true);

    deliverResult(api, ctx, result(1));
    mock.timers.tick(50); // still within the 200ms debounce window
    deliverResult(api, ctx, result(2));
    mock.timers.tick(200);

    assert.equal(sentMessages.length, 2, "both results delivered");
    assert.deepEqual(
      sentMessages[0].options,
      { triggerTurn: true, deliverAs: "steer" },
      "first result triggers the turn",
    );
    assert.deepEqual(
      sentMessages[1].options,
      { deliverAs: "followUp" },
      "second result rides the same turn instead of triggering another",
    );
  });

  it("does not deliver anything before the debounce window elapses", () => {
    const { sentMessages, api } = createMockExtensionApi();
    const { ctx } = createMockContext(true);

    deliverResult(api, ctx, result(1));
    mock.timers.tick(199);

    assert.equal(sentMessages.length, 0);
  });

  it("defers delivery while the session is busy, then flushes once idle", () => {
    const { api, sentMessages } = createMockExtensionApi();
    const { ctx, setIdle } = createMockContext(false);

    deliverResult(api, ctx, result(1));
    mock.timers.tick(200); // flush fires but session is busy

    assert.equal(sentMessages.length, 0, "held back while busy");

    setIdle(true);
    mock.timers.tick(500); // idle retry interval

    assert.equal(sentMessages.length, 1, "flushed once idle");
    assert.deepEqual(sentMessages[0].options, { triggerTurn: true, deliverAs: "steer" });
  });

  it("keeps retrying at the idle-retry cadence while busy persists", () => {
    const { api, sentMessages } = createMockExtensionApi();
    const { ctx } = createMockContext(false);

    deliverResult(api, ctx, result(1));
    mock.timers.tick(200); // first flush attempt: busy
    mock.timers.tick(500); // second attempt: still busy
    mock.timers.tick(500); // third attempt: still busy

    assert.equal(sentMessages.length, 0);
  });

  it("persists a pending batch to the orphan sink if the context throws (stale/torn-down session)", () => {
    const { api, sentMessages } = createMockExtensionApi();
    const orphaned: Array<Array<{ content: string }>> = [];
    __test__.setOrphanSink((batch) => orphaned.push(batch as any));
    const ctx = {
      isIdle: () => {
        throw new Error("session reloaded");
      },
    } as any;

    deliverResult(api, ctx, result(1));
    mock.timers.tick(200);

    assert.equal(sentMessages.length, 0, "not delivered through a dead context");
    assert.equal(orphaned.length, 1, "batch handed to the orphan sink rather than silently dropped");
    assert.equal(orphaned[0][0].content, "result 1");
  });

  it("force-delivers as a triggered steer once the max idle-wait elapses, even while busy", () => {
    mock.timers.reset();
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { api, sentMessages } = createMockExtensionApi();
    const { ctx } = createMockContext(false); // never goes idle

    deliverResult(api, ctx, result(1));
    mock.timers.tick(200); // first flush: busy, start deferring
    // Advance well past the 30s cap at the 500ms idle-retry cadence.
    for (let i = 0; i < 61; i++) mock.timers.tick(500);

    assert.equal(sentMessages.length, 1, "force-delivered after the max wait despite never idling");
    assert.deepEqual(sentMessages[0].options, { triggerTurn: true, deliverAs: "steer" });
  });

  it("starts a fresh batch after a prior batch has flushed", () => {
    const { api, sentMessages } = createMockExtensionApi();
    const { ctx } = createMockContext(true);

    deliverResult(api, ctx, result(1));
    mock.timers.tick(200);
    assert.equal(sentMessages.length, 1);

    deliverResult(api, ctx, result(2));
    mock.timers.tick(200);

    assert.equal(sentMessages.length, 2);
    assert.deepEqual(
      sentMessages[1].options,
      { triggerTurn: true, deliverAs: "steer" },
      "new batch triggers its own turn rather than riding the flushed one",
    );
  });
});

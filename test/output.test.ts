import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  injectOutputInstruction,
  resolveOutputPath,
  resolveOutputAfterRun,
  snapshotOutput,
} from "../pi-extension/subagents/output.ts";

describe("output.ts", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cohort-bridge-output-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("resolveOutputPath", () => {
    it("passes absolute paths through", () => {
      assert.equal(resolveOutputPath("/tmp/out.md", "/anywhere"), "/tmp/out.md");
    });

    it("resolves relative paths against cwd", () => {
      assert.equal(resolveOutputPath("out.md", "/base"), "/base/out.md");
    });

    it("returns undefined for booleans, false-strings, and empties", () => {
      assert.equal(resolveOutputPath(false, "/base"), undefined);
      assert.equal(resolveOutputPath(true, "/base"), undefined);
      assert.equal(resolveOutputPath("false", "/base"), undefined);
      assert.equal(resolveOutputPath("true", "/base"), undefined);
      assert.equal(resolveOutputPath("", "/base"), undefined);
      assert.equal(resolveOutputPath(undefined, "/base"), undefined);
    });
  });

  describe("injectOutputInstruction", () => {
    it("appends the write instruction when a path is set", () => {
      const result = injectOutputInstruction("do the thing", "/tmp/out.md");
      assert.match(result, /^do the thing\n\n---\n\*\*Output:\*\* Write your findings to: \/tmp\/out\.md$/);
    });

    it("returns the task unchanged without a path", () => {
      assert.equal(injectOutputInstruction("do the thing", undefined), "do the thing");
    });
  });

  describe("resolveOutputAfterRun", () => {
    it("keeps a file the child wrote and reports a reference", () => {
      const path = join(dir, "out.md");
      const before = snapshotOutput(path);
      assert.deepEqual(before, { exists: false });

      writeFileSync(path, "child findings\n", "utf8");
      const resolved = resolveOutputAfterRun(path, before, "fallback summary");
      assert.equal(resolved.savedPath, path);
      assert.equal(readFileSync(path, "utf8"), "child findings\n");
      assert.match(resolved.referenceMessage ?? "", /Output saved to: .*out\.md \(15 B, 1 line\)/);
    });

    it("detects a change to a pre-existing file", () => {
      const path = join(dir, "out.md");
      writeFileSync(path, "stale", "utf8");
      const before = snapshotOutput(path);

      writeFileSync(path, "fresh child findings", "utf8");
      const resolved = resolveOutputAfterRun(path, before, "fallback summary");
      assert.equal(resolved.savedPath, path);
      assert.equal(readFileSync(path, "utf8"), "fresh child findings");
    });

    it("persists the fallback summary when the child never wrote", () => {
      const path = join(dir, "nested", "out.md");
      const before = snapshotOutput(path);

      const resolved = resolveOutputAfterRun(path, before, "fallback summary");
      assert.equal(resolved.savedPath, path);
      assert.equal(readFileSync(path, "utf8"), "fallback summary");
      assert.match(resolved.referenceMessage ?? "", /Read this file if needed\.$/);
    });

    it("persists the fallback when a pre-existing file is untouched", () => {
      const path = join(dir, "out.md");
      writeFileSync(path, "stale", "utf8");
      // Pin mtime so the snapshot comparison can't be fooled by write timing.
      utimesSync(path, new Date(0), new Date(0));
      const before = snapshotOutput(path);

      const resolved = resolveOutputAfterRun(path, before, "fallback summary");
      assert.equal(resolved.savedPath, path);
      assert.equal(readFileSync(path, "utf8"), "fallback summary");
    });

    it("no-ops without a path", () => {
      assert.deepEqual(resolveOutputAfterRun(undefined, undefined, "x"), {});
    });
  });
});

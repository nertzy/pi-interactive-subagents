import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  decidePaneRouting,
  loadCohortWorktreeRuntime,
  runWorktreeLifecycle,
} from "../pi-extension/cohort-bridge.ts";

test("routes parallel isolated-worktree calls to panes", () => {
  assert.deepEqual(decidePaneRouting({
    tasks: [{ agent: "worker", task: "one" }, { agent: "worker", task: "two" }],
    worktree: true,
  }, true), { route: "pane" });
});

test("loads the installed pi-cohort worktree runtime through its TypeScript loader", async () => {
  const runtime = await loadCohortWorktreeRuntime(process.cwd());
  assert.equal(typeof runtime.api.createWorktrees, "function");
  assert.equal(typeof runtime.config, "object");
});

test("worktree lifecycle uses isolated cwd, rebases task paths, captures diffs, and cleans up", async () => {
  const calls: string[] = [];
  const setup = { worktrees: [{ agentCwd: "/tmp/wt-0" }, { agentCwd: "/tmp/wt-1" }] };
  const api = {
    findWorktreeTaskCwdConflict: () => undefined,
    formatWorktreeTaskCwdConflict: () => "conflict",
    createWorktrees: () => { calls.push("create"); return setup; },
    diffWorktrees: () => { calls.push("diff"); return [{ filesChanged: 1 }]; },
    formatWorktreeDiffSummary: () => "=== Worktree Changes ===\nFull patches: /tmp/diffs",
    cleanupWorktrees: () => { calls.push("cleanup"); },
  };
  const result = await runWorktreeLifecycle(
    api, "/repo", "run",
    [
      { name: "one", agent: "worker", cwd: "/repo", task: "one", outputPath: "/repo/results/one.md", reads: ["docs/one.md"], progress: "status.md" },
      { name: "two", agent: "worker", cwd: "/repo", task: "two", outputPath: "/repo/results/two.md", reads: ["/repo/docs/two.md"], progress: true },
    ],
    "/tmp/diffs",
    async (specs) => {
      assert.deepEqual(specs.map((spec) => spec.cwd), ["/tmp/wt-0", "/tmp/wt-1"]);
      assert.deepEqual(specs.map((spec) => spec.outputPath), ["/tmp/wt-0/results/one.md", "/tmp/wt-1/results/two.md"]);
      assert.deepEqual(specs.map((spec) => spec.reads), [["docs/one.md"], ["/tmp/wt-1/docs/two.md"]]);
      assert.deepEqual(specs.map((spec) => spec.progress), ["status.md", true]);
      calls.push("run");
      return ["one", "two"];
    },
  );
  assert.deepEqual(calls, ["create", "run", "diff", "cleanup"]);
  assert.deepEqual(result.outcomes, ["one", "two"]);
  assert.match(result.diffSummary, /Full patches/);
});

test("worktree lifecycle preserves requested output artifacts after temporary cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "cohort-worktree-output-"));
  const worktree = join(root, "temporary-worktree");
  const diffs = join(root, "artifacts", "worktree-diffs");
  const output = join(worktree, "result.md");
  const api = {
    findWorktreeTaskCwdConflict: (tasks: unknown, cwd: string) => {
      assert.equal(cwd, join(root, "repo", "nested"));
      return undefined;
    },
    createWorktrees: () => ({ worktrees: [{ agentCwd: worktree }] }),
    diffWorktrees: () => [],
    formatWorktreeDiffSummary: () => "",
    cleanupWorktrees: () => rmSync(worktree, { recursive: true, force: true }),
  };
  const result = await runWorktreeLifecycle(
    api, join(root, "repo", "nested"), "run",
    [{ name: "worker", cwd: join(root, "repo", "nested"), outputPath: join(root, "repo", "nested", "result.md"), outputRelativePath: "result.md" }],
    diffs,
    async (specs) => {
      const path = specs[0]!.outputPath!;
      const directory = path.slice(0, path.lastIndexOf("/"));
      mkdirSync(directory, { recursive: true });
      writeFileSync(path, "survives");
      return [{ savedOutputPath: specs[0]!.outputPath }];
    },
  );
  const saved = (result.outcomes[0] as { savedOutputPath: string }).savedOutputPath;
  assert.equal(saved, join(root, "artifacts", "worktree-diffs", "worktree-outputs", "child-0", "result.md"));
  assert.equal(readFileSync(saved, "utf8"), "survives");
  assert.equal(existsSync(worktree), false);
  rmSync(root, { recursive: true, force: true });
});

test("separate static chain worktree groups persist same-named outputs without overwrite", async () => {
  const root = mkdtempSync(join(tmpdir(), "cohort-worktree-groups-"));
  const runGroup = async (group: string, contents: string) => {
    const worktree = join(root, `worktree-${group}`);
    const api = {
      findWorktreeTaskCwdConflict: () => undefined,
      createWorktrees: () => ({ worktrees: [{ agentCwd: worktree }] }),
      diffWorktrees: () => [],
      formatWorktreeDiffSummary: () => "",
      cleanupWorktrees: () => rmSync(worktree, { recursive: true, force: true }),
    };
    return runWorktreeLifecycle(api, root, group, [{ name: "child-0", cwd: root, outputPath: join(root, "result.md"), outputRelativePath: "result.md" }], join(root, "chain", "worktree-diffs", group), async (specs) => {
      mkdirSync(worktree, { recursive: true });
      writeFileSync(specs[0]!.outputPath!, contents);
      return [{ savedOutputPath: specs[0]!.outputPath }];
    });
  };

  const first = await runGroup("group-0", "first");
  const second = await runGroup("group-2", "second");
  const firstPath = (first.outcomes[0] as { savedOutputPath: string }).savedOutputPath;
  const secondPath = (second.outcomes[0] as { savedOutputPath: string }).savedOutputPath;
  assert.notEqual(firstPath, secondPath);
  assert.equal(readFileSync(firstPath, "utf8"), "first");
  assert.equal(readFileSync(secondPath, "utf8"), "second");
  assert.match(firstPath, /group-0\/worktree-outputs\/child-0\/result\.md$/);
  assert.match(secondPath, /group-2\/worktree-outputs\/child-0\/result\.md$/);
  rmSync(root, { recursive: true, force: true });
});

test("worktree lifecycle cleans up when setup-adjacent execution fails", async () => {
  let cleaned = false;
  const api = {
    findWorktreeTaskCwdConflict: () => undefined,
    createWorktrees: () => ({ worktrees: [{ agentCwd: "/tmp/wt" }] }),
    cleanupWorktrees: () => { cleaned = true; },
  };
  await assert.rejects(runWorktreeLifecycle(
    api, "/repo", "run", [{ name: "worker", cwd: "/repo" }], "/tmp/diffs",
    async () => { throw new Error("launch failed"); },
  ), /launch failed/);
  assert.equal(cleaned, true);
});

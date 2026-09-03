import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyPaneClarification,
  evaluateDynamicGroupAcceptance,
  executePaneChain,
  resolvePaneChainDir,
  validatePaneChain,
  type PaneChainStep,
} from "../pi-extension/cohort-bridge.ts";

test("top-level chainDir is a base and each run gets a unique child directory", () => {
  assert.equal(resolvePaneChainDir({ cwd: "/tmp/project", chainDir: "custom/chain" }, "run-id"), "/tmp/project/custom/chain/run-id");
  assert.equal(resolvePaneChainDir({ cwd: "/tmp/project", chainDir: "custom/chain" }, "other-id"), "/tmp/project/custom/chain/other-id");
  assert.match(resolvePaneChainDir({ cwd: "/tmp/project" }, "run-id"), /artifacts\/run-id\/chain$/);
});

test("sequential pane chains resolve templates, named outputs, and per-step settings", async () => {
  const chainDir = mkdtempSync(join(tmpdir(), "pane-chain-"));
  const seen: Array<{ task: string; agent?: string; model?: string; cwd: string }> = [];
  const chain: PaneChainStep[] = [
    { agent: "scout", task: "Inspect {task} in {chain_dir}", as: "findings", model: "fast" },
    { agent: "worker", task: "Use {previous}; named={outputs.findings}", cwd: "nested" },
  ];

  const result = await executePaneChain(chain, {
    originalTask: "the request",
    cwd: "/tmp/project",
    chainDir,
    run: async (spec) => {
      seen.push({ task: spec.task, agent: spec.agent, model: spec.model, cwd: spec.cwd });
      return { name: spec.name, agent: spec.agent, index: spec.index, exitCode: 0, elapsedText: "0s", summary: `result-${spec.index}`, sessionFile: `session-${spec.index}` };
    },
  });

  assert.equal(seen[0]?.task, `Inspect the request in ${chainDir}`);
  assert.deepEqual(seen[0] && { agent: seen[0].agent, model: seen[0].model }, { agent: "scout", model: "fast" });
  assert.equal(seen[1]?.task, "Use result-0; named=result-0");
  assert.equal(seen[1]?.cwd, "/tmp/project/nested");
  assert.equal(result.previous, "result-1");
  assert.equal(result.outputs.findings?.text, "result-0");
  assert.equal(result.steps.length, 2);
});

test("static parallel chain steps run concurrently and aggregate in stable order", async () => {
  let active = 0;
  let peak = 0;
  const chain: PaneChainStep[] = [
    { parallel: [
      { agent: "slow", task: "A {task}", as: "alpha" },
      { agent: "fast", task: "B {task}", as: "beta" },
    ], concurrency: 2 },
    { agent: "collector", task: "{previous}|{outputs.alpha}|{outputs.beta}" },
  ];
  const result = await executePaneChain(chain, {
    originalTask: "input",
    cwd: "/tmp/project",
    chainDir: "/tmp/chain",
    run: async (spec) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, spec.agent === "slow" ? 20 : 5));
      active--;
      return { name: spec.name, agent: spec.agent, index: spec.index, exitCode: 0, elapsedText: "0s", summary: spec.agent === "slow" ? "one" : spec.agent === "fast" ? "two" : spec.task, sessionFile: `s-${spec.index}` };
    },
  });

  assert.equal(peak, 2);
  assert.equal(result.steps[2]?.summary, "=== Parallel Task 1 (slow) ===\none\n\n=== Parallel Task 2 (fast) ===\ntwo|one|two");
  assert.equal(result.previous, "=== Parallel Task 1 (slow) ===\none\n\n=== Parallel Task 2 (fast) ===\ntwo|one|two");
  assert.deepEqual(Object.fromEntries(Object.entries(result.outputs).map(([name, value]) => [name, value.text])), { alpha: "one", beta: "two" });
});

test("static parallel chain groups reject duplicate resolved output paths before launch", async () => {
  let launches = 0;
  await assert.rejects(executePaneChain([{ parallel: [
    { agent: "worker", task: "one", output: "same.md" },
    { agent: "reviewer", task: "two", output: "same.md" },
  ] }], {
    originalTask: "request", cwd: "/tmp/project", chainDir: "/tmp/chain",
    run: async () => { launches++; throw new Error("must not launch"); },
  }), /Parallel tasks 1 \(worker\) and 2 \(reviewer\) resolve output to the same path: .*same\.md\. Use distinct output paths\./);
  assert.equal(launches, 0);
});

test("static parallel chain worktree groups use isolated rebased paths and lifecycle callback", async () => {
  let lifecycleCalls = 0;
  const seen: Array<{ cwd: string; outputPath?: string; reads?: string[] | false; progress?: boolean | string }> = [];
  await executePaneChain([{ parallel: [
    { agent: "worker", task: "one", output: "results/one.md", reads: ["docs/input.md"], progress: "progress.md" },
    { agent: "worker", task: "two", cwd: "nested", output: "result.md" },
  ], worktree: true }], {
    originalTask: "request", cwd: "/repo", chainDir: "/repo/artifacts/chain",
    runWorktreeGroup: async (specs, run, sharedCwd) => {
      lifecycleCalls++;
      assert.equal(sharedCwd, "/repo");
      return run(specs.map((spec, index) => ({
        ...spec,
        cwd: `/tmp/wt-${index}${index ? "/nested" : ""}`,
        outputPath: `/tmp/wt-${index}${index ? "/nested" : ""}/${index ? "result.md" : "results/one.md"}`,
        reads: spec.reads,
        progress: spec.progress,
      })));
    },
    run: async (spec) => {
      seen.push({ cwd: spec.cwd, outputPath: spec.outputPath, reads: spec.reads, progress: spec.progress });
      return { name: spec.name, agent: spec.agent, index: spec.index, exitCode: 0, elapsedText: "0s", summary: "done", sessionFile: "s" };
    },
  });
  assert.equal(lifecycleCalls, 1);
  assert.deepEqual(seen.map(({ cwd, outputPath }) => ({ cwd, outputPath })), [
    { cwd: "/tmp/wt-0", outputPath: "/tmp/wt-0/results/one.md" },
    { cwd: "/tmp/wt-1/nested", outputPath: "/tmp/wt-1/nested/result.md" },
  ]);
});

test("static parallel worktree lifecycle receives the resolved group-level cwd", async () => {
  let lifecycleCwd = "";
  await executePaneChain([{ parallel: [
    { agent: "worker", task: "one" },
    { agent: "worker", task: "two" },
  ], cwd: "nested", worktree: true }], {
    originalTask: "request", cwd: "/repo", chainDir: "/repo/artifacts/chain",
    runWorktreeGroup: async (specs, run, sharedCwd) => {
      lifecycleCwd = sharedCwd;
      return run(specs);
    },
    run: async (spec) => ({ name: spec.name, agent: spec.agent, index: spec.index, exitCode: 0, elapsedText: "0s", summary: "done", sessionFile: "s" }),
  });
  assert.equal(lifecycleCwd, "/repo/nested");
});

test("top-level chain skills merge with persona and step skills using native precedence", async () => {
  const seen: Array<{ agent?: string; skills?: string[] }> = [];
  await executePaneChain([
    { agent: "default", task: "one" },
    { agent: "override", task: "two", skill: ["step", "chain"] },
    { agent: "disabled", task: "three", skill: false },
  ], {
    originalTask: "request", cwd: "/tmp", chainDir: "/tmp/chain",
    baseSpec: { skills: ["chain", "shared"] },
    personaResolver: (agent) => ({
      filePath: agent, systemPromptMode: "replace", inheritProjectContext: false,
      inheritSkills: false, systemPrompt: "", skills: ["persona", "shared"],
    }),
    run: async (spec) => {
      seen.push({ agent: spec.agent, skills: spec.skills });
      return { name: spec.name, agent: spec.agent, index: spec.index, exitCode: 0, elapsedText: "0s", summary: "done", sessionFile: "s" };
    },
  });
  assert.deepEqual(seen, [
    { agent: "default", skills: ["persona", "shared", "chain"] },
    { agent: "override", skills: ["step", "chain", "shared"] },
    { agent: "disabled", skills: [] },
  ]);
});

test("chain failure stops subsequent launches and records the failed step", async () => {
  const launched: string[] = [];
  const result = await executePaneChain([
    { agent: "first", task: "one" },
    { agent: "broken", task: "two" },
    { agent: "never", task: "three" },
  ], {
    originalTask: "request", cwd: "/tmp", chainDir: "/tmp/chain",
    run: async (spec) => {
      launched.push(spec.agent ?? "");
      return { name: spec.name, agent: spec.agent, index: spec.index, exitCode: spec.agent === "broken" ? 1 : 0, elapsedText: "0s", summary: spec.task, sessionFile: "s" };
    },
  });
  assert.deepEqual(launched, ["first", "broken"]);
  assert.equal(result.failedStep, 1);
});

test("dynamic pane fanout expands structured named output, uses stable ids, and collects in input order", async () => {
  let active = 0;
  let peak = 0;
  const seen: Array<{ agent?: string; task: string; idKey?: string }> = [];
  const result = await executePaneChain([
    {
      agent: "planner",
      task: "plan {task}",
      as: "plan",
      outputSchema: { type: "object" },
    },
    {
      expand: { from: { output: "plan", path: "/work" }, item: "job", key: "/slug", maxItems: 3 },
      parallel: {
        agent: "worker",
        label: "worker-{job.slug}",
        task: "{task}|{previous}|{chain_dir}|{outputs.plan}|{job.slug}|{job.payload}",
        outputSchema: { type: "object" },
      },
      collect: {
        as: "completed",
        outputSchema: {
          type: "array",
          items: { type: "object", required: ["key", "index", "item", "agent", "exitCode", "text"] },
        },
      },
      concurrency: 2,
      failFast: true,
    },
    { agent: "reviewer", task: "collected={outputs.completed}; previous={previous}" },
  ] as PaneChainStep[], {
    originalTask: "request",
    cwd: "/tmp/project",
    chainDir: "/tmp/chain",
    run: async (spec) => {
      seen.push({ agent: spec.agent, task: spec.task, idKey: spec.idKey });
      if (spec.agent === "planner") {
        return {
          name: spec.name, agent: spec.agent, index: spec.index, exitCode: 0, elapsedText: "0s",
          summary: "planned", sessionFile: "planner", structuredOutput: {
            work: [{ slug: "slow-one", payload: { n: 1 } }, { slug: "fast-two", payload: { n: 2 } }],
          },
        };
      }
      if (spec.agent === "worker") {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, spec.idKey === "slow-one" ? 20 : 5));
        active--;
        return {
          name: spec.name, agent: spec.agent, index: spec.index, exitCode: 0, elapsedText: "0s",
          summary: `text-${spec.idKey}`, sessionFile: `worker-${spec.idKey}`,
          structuredOutput: { id: spec.idKey },
        };
      }
      return { name: spec.name, agent: spec.agent, index: spec.index, exitCode: 0, elapsedText: "0s", summary: spec.task, sessionFile: "reviewer" };
    },
  });

  assert.equal(peak, 2);
  assert.deepEqual(seen.filter((entry) => entry.agent === "worker").map((entry) => entry.idKey), ["slow-one", "fast-two"]);
  assert.match(seen.find((entry) => entry.agent === "worker")?.task ?? "", /request\|\{"work":/);
  assert.match(seen.find((entry) => entry.agent === "worker")?.task ?? "", /\/tmp\/chain\|/);
  assert.match(seen.find((entry) => entry.agent === "worker")?.task ?? "", /slow-one\|\{"n":1\}/);
  assert.deepEqual((result.outputs.completed?.structured as Array<{ key: string; text: string }>).map(({ key, text }) => ({ key, text })), [
    { key: "slow-one", text: "text-slow-one" },
    { key: "fast-two", text: "text-fast-two" },
  ]);
  assert.match(result.previous, /collected=\[/);
  assert.equal(result.failedStep, undefined);
});

test("dynamic fanout rejects duplicate resolved output paths before launching expanded children", async () => {
  let workerLaunches = 0;
  await assert.rejects(executePaneChain([
    { agent: "planner", task: "plan", as: "plan", outputSchema: { type: "object" } },
    {
      expand: { from: { output: "plan", path: "/items" }, maxItems: 2 },
      parallel: { agent: "worker", task: "{item}", output: "same.md" },
      collect: { as: "done" },
    },
  ], {
    originalTask: "request", cwd: "/tmp/project", chainDir: "/tmp/chain",
    run: async (spec) => {
      if (spec.agent === "worker") workerLaunches++;
      return { name: spec.name, agent: spec.agent, index: spec.index, exitCode: 0, elapsedText: "0s", summary: "done", sessionFile: "s", ...(spec.agent === "planner" ? { structuredOutput: { items: ["a", "b"] } } : {}) };
    },
  }), /Parallel tasks 1 \(worker\) and 2 \(worker\) resolve output to the same path: .*same\.md\. Use distinct output paths\./);
  assert.equal(workerLaunches, 0);
});

test("dynamic fanout honors empty, pointer, bounds, duplicate, and collection schema errors", async () => {
  const execute = (source: unknown, dynamic: Record<string, unknown>) => executePaneChain([
    { agent: "planner", task: "plan", as: "plan", outputSchema: { type: "object" } },
    dynamic,
  ] as PaneChainStep[], {
    originalTask: "request", cwd: "/tmp", chainDir: "/tmp/chain",
    run: async (spec) => ({
      name: spec.name, agent: spec.agent, index: spec.index, exitCode: 0, elapsedText: "0s",
      summary: "done", sessionFile: "s", ...(spec.agent === "planner" ? { structuredOutput: source } : {}),
    }),
  });
  const base = {
    expand: { from: { output: "plan", path: "/items" }, key: "/id", maxItems: 2 },
    parallel: { agent: "worker", task: "{item.id}" },
    collect: { as: "done" },
  };

  await assert.rejects(execute({ items: [] }, { ...base, expand: { ...base.expand, onEmpty: "fail" } }), /source array is empty/);
  await assert.rejects(execute({}, base), /expand\.from\.path does not exist/);
  await assert.rejects(execute({ items: {} }, base), /expand\.from\.path must resolve to an array/);
  await assert.rejects(execute({ items: [{ id: 1 }] }, {
    ...base, parallel: { agent: "worker", task: "{item.missing}" },
  }), /\{item\.missing\} does not exist/);
  await assert.rejects(execute({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] }, base), /exceeding maxItems 2/);
  await assert.rejects(execute({ items: [{ id: "same" }, { id: "same" }] }, base), /duplicate item key 'same'/);
  await assert.rejects(execute({ items: [{ id: "A B" }, { id: "a-b" }] }, base), /colliding item id 'a-b'/);
  await assert.rejects(execute({ items: [{ id: 1 }] }, {
    ...base,
    collect: { as: "done", outputSchema: { type: "array", maxItems: 0 } },
  }), /Collected output validation failed/);
});

test("dynamic group acceptance passes child outcomes and notes, including empty groups", async () => {
  const accepted: Array<{ outcomes: unknown[]; notes: string }> = [];
  const execute = (items: unknown[]) => executePaneChain([
    { agent: "planner", task: "plan", as: "plan", outputSchema: { type: "array" } },
    {
      expand: { from: { output: "plan", path: "" }, maxItems: 2, onEmpty: "skip" },
      parallel: { agent: "worker", task: "{item}" },
      collect: { as: "done" },
      acceptance: { level: "checked" },
    },
  ] as PaneChainStep[], {
    originalTask: "request", cwd: "/tmp", chainDir: "/tmp/chain",
    evaluateGroupAcceptance: async (acceptance, outcomes, notes) => {
      assert.deepEqual(acceptance, { level: "checked" });
      accepted.push({ outcomes, notes });
      return undefined;
    },
    run: async (spec) => ({
      name: spec.name, agent: spec.agent, index: spec.index, exitCode: 0, elapsedText: "0s",
      summary: spec.agent === "planner" ? "planned" : `report-${spec.index}`, sessionFile: "s",
      ...(spec.agent === "planner" ? { structuredOutput: items } : {}),
    }),
  });
  await execute(["one"]);
  await execute([]);
  assert.equal((accepted[0]?.outcomes[0] as { summary?: string })?.summary, "report-1");
  assert.match(accepted[0]?.notes ?? "", /collected 1 result/);
  assert.deepEqual(accepted[1], { outcomes: [], notes: "Dynamic fanout produced 0 results." });
});

test("production dynamic acceptance uses pi-cohort aggregate reports for children and zero results", async () => {
  const childReport = {
    criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "done" }],
    changedFiles: ["source.ts"], testsAddedOrUpdated: ["test.ts"],
    commandsRun: [{ command: "test", result: "passed", summary: "ok" }],
    validationOutput: ["ok"], residualRisks: [], noStagedFiles: true,
  };
  const childFailure = await evaluateDynamicGroupAcceptance(
    { level: "checked" },
    [{ name: "worker", agent: "worker", index: 0, exitCode: 0, elapsedText: "0s", summary: "done", sessionFile: "s", acceptance: { status: "accepted", childReport } }],
    "Dynamic fanout collected 1 result(s) into done.", process.cwd(), "worker", "implement",
  );
  assert.doesNotMatch(childFailure ?? "", /Structured acceptance report not found/);

  const emptyFailure = await evaluateDynamicGroupAcceptance(
    { level: "checked" }, [], "Dynamic fanout produced 0 results.", process.cwd(), "worker", "implement",
  );
  assert.match(emptyFailure ?? "", /criterion|evidence|acceptance/i);
  assert.doesNotMatch(emptyFailure ?? "", /Structured acceptance report not found/);
});

test("dynamic failFast stops launching queued pane children", async () => {
  const launched: number[] = [];
  const result = await executePaneChain([
    { agent: "planner", task: "plan", as: "plan", outputSchema: { type: "array" } },
    {
      expand: { from: { output: "plan", path: "" }, maxItems: 4 },
      parallel: { agent: "worker", task: "{item}" },
      collect: { as: "done" }, concurrency: 1, failFast: true,
    },
    { agent: "never", task: "never" },
  ] as PaneChainStep[], {
    originalTask: "request", cwd: "/tmp", chainDir: "/tmp/chain",
    run: async (spec) => {
      if (spec.agent === "planner") return { name: spec.name, agent: spec.agent, index: spec.index, exitCode: 0, elapsedText: "0s", summary: "plan", sessionFile: "s", structuredOutput: [1, 2, 3, 4] };
      launched.push(spec.index);
      return { name: spec.name, agent: spec.agent, index: spec.index, exitCode: 1, elapsedText: "0s", summary: "failed", sessionFile: "s" };
    },
  });
  assert.deepEqual(launched, [1]);
  assert.equal(result.failedStep, 1);
});

test("validates all chain shapes and output references before pane launch", () => {
  assert.throws(() => validatePaneChain([{ agent: "worker", task: "{outputs.later}" }]), /Unknown chain output reference/);
  assert.throws(() => validatePaneChain([{ parallel: [] }]), /non-empty parallel array/);
  assert.throws(() => validatePaneChain([{ expand: {}, parallel: { agent: "worker" }, collect: {} } as unknown as PaneChainStep]), /requires expand\.from/);
  assert.throws(() => validatePaneChain([{ agent: "worker", task: "ok", outputMode: "file-only" }]), /output path/);
});

test("clarification applies pi-cohort UI edits before pane execution", async () => {
  const params = { agent: "worker", task: "draft", model: "old", clarify: true };
  const clarified = await applyPaneClarification(params, async () => ({
    confirmed: true,
    templates: ["edited"],
    behaviorOverrides: [{ model: "new", output: "result.md", skills: ["tdd"] }],
  }));
  assert.deepEqual(clarified, { ...params, task: "edited", model: "new", output: "result.md", skill: ["tdd"], clarify: false });
  assert.equal(await applyPaneClarification(params, async () => undefined), undefined);
});

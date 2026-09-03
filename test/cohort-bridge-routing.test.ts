import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyPersonaDefaultContext, buildPaneLaunchCommand, buildPanePromptArgs, buildPaneTask, buildParallelSpecs, coerceNativeFallbackInput, decidePaneRouting, formatPaneFailure, resolvePaneSkills, validatePaneRequestBoundary, validatePaneSubagentRequest } from "../pi-extension/cohort-bridge.ts";
import { resolvePersona } from "../pi-extension/subagents/persona-resolve.ts";

test("routes pane-supported calls", () => {
  for (const params of [
    { agent: "worker", task: "work" },
    { agent: "worker", task: "work", context: "fork" },
    { agent: "worker", task: "work", skill: ["tdd"] },
    { agent: "worker", task: "work", acceptance: "checked" },
    { agent: "worker", task: "work", outputSchema: { type: "object" } },
    { agent: "worker", task: "work", acceptance: { verify: [{ id: "test", command: "npm test" }] } },
    { agent: "worker", task: "work", acceptance: { review: { required: true } } },
    { agent: "worker", task: "work", clarify: true },
    { chain: [{ agent: "scout", task: "one" }, { agent: "worker", task: "{previous}" }] },
    { chain: [{ parallel: [{ agent: "scout", task: "one" }, { agent: "reviewer", task: "two" }] }] },
    { chain: [{ agent: "planner", task: "plan", as: "plan" }, { expand: { from: { output: "plan", path: "/items" }, maxItems: 3 }, parallel: { agent: "worker", task: "{item}" }, collect: { as: "done" } }] },
    { tasks: [{ agent: "scout", task: "one", outputSchema: { type: "object" } }, { agent: "reviewer", task: "two", progress: true, reads: ["notes.md"] }] },
  ]) assert.deepEqual(decidePaneRouting(params, true), { route: "pane" });
});

test("reserves native fallback for unavailable muxes and future orchestration fields", () => {
  assert.match(decidePaneRouting({ agent: "worker", task: "x" }, false).reason ?? "", /no supported terminal multiplexer/i);
  assert.match(decidePaneRouting({ tasks: [{ agent: "worker", task: "x", futureOption: true }] }, true).reason ?? "", /unsupported orchestration fields/i);
  assert.deepEqual(decidePaneRouting({ agent: "worker", task: "x", worktree: true }, true), { route: "pane" });
  assert.deepEqual(decidePaneRouting({ tasks: [{ agent: "worker" }] }, true), { route: "pane" });
});

test("applies invocation-wide fork defaults from all resolved pi-cohort personas unless explicitly overridden", () => {
  for (const agent of ["worker", "planner", "oracle"]) {
    assert.equal(resolvePersona(agent, process.cwd())?.defaultContext, "fork");
    assert.equal(applyPersonaDefaultContext({ agent, task: "work" }).context, "fork");
  }
  assert.equal(applyPersonaDefaultContext({
    tasks: [{ agent: "scout", task: "inspect" }, { agent: "worker", task: "implement" }],
  }).context, "fork");
  assert.equal(applyPersonaDefaultContext({
    chain: [{ agent: "scout", task: "inspect" }, { agent: "planner", task: "plan" }],
  }).context, "fork");
  assert.equal(applyPersonaDefaultContext({ agent: "worker", task: "work", context: "fresh" }).context, "fresh");
});

test("builtin defaultContext overrides replace builtin frontmatter, including fresh and false", () => {
  const root = mkdtempSync(join(tmpdir(), "pane-builtin-context-"));
  const packageRoot = join(root, ".pi", "npm", "node_modules", "pi-cohort");
  mkdirSync(join(packageRoot, "agents"), { recursive: true });
  writeFileSync(join(packageRoot, "agents", "worker.md"), "---\nname: worker\ndescription: Worker\ndefaultContext: fork\n---\nBuiltin worker");
  const settingsPath = join(root, ".pi", "settings.json");
  const settings = (defaultContext: "fresh" | false) => JSON.stringify({
    packages: ["npm:pi-cohort"],
    subagents: { agentOverrides: { worker: { defaultContext } } },
  });

  writeFileSync(settingsPath, settings("fresh"));
  assert.equal(resolvePersona("worker", root)?.defaultContext, "fresh");
  assert.equal(applyPersonaDefaultContext({ agent: "worker", task: "work", cwd: root }).context, undefined);

  writeFileSync(settingsPath, settings(false));
  assert.equal(resolvePersona("worker", root)?.defaultContext, undefined);
  assert.equal(applyPersonaDefaultContext({ agent: "worker", task: "work", cwd: root }).context, undefined);
  rmSync(root, { recursive: true, force: true });
});

test("builtin overrides use replacement and composition semantics for every pane-relevant field", () => {
  const root = mkdtempSync(join(tmpdir(), "pane-builtin-overrides-"));
  const packageRoot = join(root, ".pi", "npm", "node_modules", "pi-cohort");
  mkdirSync(join(packageRoot, "agents"), { recursive: true });
  writeFileSync(join(packageRoot, "agents", "worker.md"), "---\nname: worker\ndescription: Worker\nmodel: old/model\nthinking: high\nsystemPromptMode: append\ninheritProjectContext: true\ninheritSkills: true\ndefaultContext: fork\ntools: read,bash\nskills: tdd\n---\nBuiltin prompt");
  writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({
    packages: ["npm:pi-cohort"],
    subagents: { agentOverrides: { worker: {
      model: false, thinking: false, systemPromptMode: "replace",
      inheritProjectContext: false, inheritSkills: false, defaultContext: false,
      systemPrompt: "Overridden prompt", skills: false, tools: ["edit"],
      toolsPrepend: ["read"], toolsAppend: ["bash", "write"],
    } } },
  }));

  const persona = resolvePersona("worker", root);
  assert.deepEqual(persona && {
    model: persona.model, thinking: persona.thinking, systemPromptMode: persona.systemPromptMode,
    inheritProjectContext: persona.inheritProjectContext, inheritSkills: persona.inheritSkills,
    defaultContext: persona.defaultContext, systemPrompt: persona.systemPrompt,
    skills: persona.skills, tools: persona.tools,
  }, {
    model: undefined, thinking: undefined, systemPromptMode: "replace",
    inheritProjectContext: false, inheritSkills: false, defaultContext: undefined,
    systemPrompt: "Overridden prompt", skills: undefined,
    tools: ["read", "edit", "bash", "write"],
  });
  rmSync(root, { recursive: true, force: true });
});

test("disabled builtins fail before parallel pane specs can launch", () => {
  const root = mkdtempSync(join(tmpdir(), "pane-disabled-builtin-"));
  const packageRoot = join(root, ".pi", "npm", "node_modules", "pi-cohort");
  mkdirSync(join(packageRoot, "agents"), { recursive: true });
  writeFileSync(join(packageRoot, "agents", "worker.md"), "---\nname: worker\ndescription: Worker\n---\nWorker");
  writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:pi-cohort"], subagents: { agentOverrides: { worker: { disabled: true } } } }));
  assert.throws(() => buildParallelSpecs({ cwd: root, tasks: [{ agent: "worker", task: "work" }] }, "run", "parent"), /disabled/i);
  rmSync(root, { recursive: true, force: true });
});

test("rejects duplicate resolved output paths after count expansion", () => {
  assert.throws(
    () => buildParallelSpecs({ tasks: [{ agent: "worker", task: "work", count: 2, output: "same.md" }] }, "run", "parent"),
    /Parallel tasks 1 \(worker\) and 2 \(worker\) resolve output to the same path: .*same\.md\. Use distinct output paths\./,
  );
});

test("top-level parallel task cwd is resolved from the invocation cwd before persona discovery", () => {
  const root = mkdtempSync(join(tmpdir(), "pane-parallel-cwd-"));
  const nested = join(root, "nested");
  mkdirSync(join(nested, ".pi", "agents"), { recursive: true });
  writeFileSync(join(nested, ".pi", "agents", "local.md"), "---\nname: local\ndescription: Local\ndefaultContext: fork\n---\nLocal agent");

  const previous = process.cwd();
  process.chdir(root);
  try {
    const specs = buildParallelSpecs({ cwd: root, tasks: [{ agent: "local", task: "work", cwd: "nested" }] }, "run", "parent");
    assert.equal(specs?.[0]?.cwd, nested);
    assert.equal(specs?.[0]?.persona?.filePath, join(nested, ".pi", "agents", "local.md"));
    assert.equal(applyPersonaDefaultContext({ cwd: root, tasks: [{ agent: "local", task: "work", cwd: "nested" }] }).context, "fork");
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
});

test("coerces only genuine native fallbacks async unless foreground is explicit", () => {
  assert.deepEqual(coerceNativeFallbackInput({ agent: "worker", task: "x" }), { input: { agent: "worker", task: "x", async: true }, coercedAsync: true });
  assert.equal(coerceNativeFallbackInput({ agent: "worker", task: "x", async: false }).coercedAsync, false);
  assert.equal(coerceNativeFallbackInput({ agent: "worker", task: "x", clarify: true }).coercedAsync, false);
});

test("invalid current request semantics fail before backend launch without mutating input", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ task: "work" }, /agent must be a non-empty string/],
    [{ agent: "missing-agent", task: "work" }, /Unknown agent 'missing-agent'/],
    [{ agent: "worker", task: "work", skill: "missing-skill" }, /Skill 'missing-skill' was not found/],
    [{ agent: "worker", task: "work", output: true }, /output must be a path string or false/],
    [{ agent: "worker", task: "work", outputMode: "file-only" }, /file-only.*output path/],
    [{ agent: "worker", task: "work", worktree: true }, /worktree isolation is only supported/],
    [{ tasks: [{ agent: "worker" }] }, /Parallel task 1 requires a non-empty task/],
    [{ tasks: [{ agent: "missing-agent", task: "work" }] }, /Unknown agent 'missing-agent'/],
    [{ tasks: [{ agent: "worker", task: "work", skill: "missing-skill" }] }, /Skill 'missing-skill' was not found/],
    [{ chain: [null] }, /Chain step 1 must be an object/],
    [{ chain: [{ agent: "missing-agent", task: "work" }] }, /Unknown agent 'missing-agent'/],
    [{ chain: [{ parallel: [{ agent: "missing-agent", task: "work" }] }] }, /Unknown agent 'missing-agent'/],
    [{ chain: [{ agent: "worker", task: "work", output: true }] }, /output must be a concrete path or false/],
    [{ chain: [{ agent: "planner", task: "plan", as: "plan" }, { parallel: { agent: "missing-agent", task: "{item}" }, expand: { from: { output: "plan", path: "/items" }, maxItems: 1 }, collect: { as: "done" } }] }, /Unknown agent 'missing-agent'/],
  ];
  let launches = 0;
  for (const [input, message] of cases) {
    const before = structuredClone(input);
    const result = await validatePaneRequestBoundary(input, { beforeLaunch: () => { launches++; } });
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /^Invalid pane subagent request: /);
    assert.match(result?.reason ?? "", message);
    assert.deepEqual(input, before, "validation must not mutate the native tool input");
  }
  assert.equal(launches, 0, "invalid requests must not reach pane launch");
});

test("valid current request semantics reach the pane boundary without native mutation", async () => {
  const input = { agent: "scout", task: "inspect", async: false };
  let launches = 0;
  assert.equal(await validatePaneRequestBoundary(input, { beforeLaunch: () => { launches++; } }), undefined);
  assert.equal(launches, 1);
  assert.deepEqual(input, { agent: "scout", task: "inspect", async: false });
});

test("inferred acceptance reviewer is validated before worker launch", async () => {
  let launches = 0;
  await assert.rejects(validatePaneSubagentRequest(
    { agent: "worker", task: "implement the change", async: true },
    {
      resolvePersona: (agent) => agent === "worker" ? resolvePersona("worker", process.cwd()) : undefined,
      beforeLaunch: () => { launches++; },
    },
  ), /Unknown acceptance reviewer agent 'reviewer'/);
  assert.equal(launches, 0);
});

test("builds pane instructions and preserves skill semantics", () => {
  const task = buildPaneTask("Do work", { acceptance: { level: "checked", evidence: ["changed-files"] }, reads: ["notes.md"], progress: true, cwd: "/tmp/project" });
  assert.match(task, /Read before starting: \/tmp\/project\/notes\.md/);
  assert.match(task, /Maintain progress at: \/tmp\/project\/progress\.md/);
  assert.match(task, /```acceptance-report/);
  assert.deepEqual(resolvePaneSkills(["persona"], undefined), ["persona"]);
  assert.deepEqual(resolvePaneSkills(["persona"], ["call"]), ["persona", "call"]);
  assert.deepEqual(resolvePaneSkills(["persona"], false), []);
  assert.deepEqual(buildPanePromptArgs(["tdd", "verify"], "/tmp/task.md"), ["", "/skill:tdd", "/skill:verify", "@/tmp/task.md"]);
});

test("pane launch uses the retention-mode fish launcher with its env and arguments", () => {
  for (const [agentDir, launcher] of [
    ["/tmp/agent.anthropic", "pi-anthropic"],
    ["/tmp/agent.balanced", "pi-balanced"],
    ["/tmp/agent.local", "pi-local"],
  ]) {
    const command = buildPaneLaunchCommand(
      agentDir,
      "/tmp/project",
      ["PI_SUBAGENT_ID='run-0'", `PI_CODING_AGENT_DIR='${agentDir}'`],
      ["--session", "'/tmp/child session.jsonl'", "--model", "'provider/model'"],
    );
    assert.match(command, new RegExp(`fish -lc '${launcher} `));
    assert.match(command, /PI_SUBAGENT_ID='run-0'/);
    assert.match(command, new RegExp(`PI_CODING_AGENT_DIR='${agentDir.replaceAll(".", "\\.")}'`));
    assert.match(command, /--session.*child session\.jsonl.*--model.*provider\/model/);
    assert.doesNotMatch(command, /(?:^|\s)pi --session/);
  }

  assert.throws(
    () => buildPaneLaunchCommand("/tmp/agent.custom", "/tmp/project", [], ["--session", "child.jsonl"]),
    /Unsupported PI_CODING_AGENT_DIR.*agent\.custom/,
  );
});

test("pane failures expose terminal output and launch artifact", () => {
  const message = formatPaneFailure("worker", 1, "Authentication failed\n", "/tmp/launch.sh");
  assert.match(message, /worker exited with code 1/);
  assert.match(message, /Authentication failed/);
  assert.match(message, /\/tmp\/launch\.sh/);
});

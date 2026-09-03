import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  finalizePaneOutcome,
  loadCohortRuntime,
  type PaneCompletion,
} from "../pi-extension/cohort-bridge.ts";

function completion(summary = "done"): PaneCompletion {
  return { exitCode: 0, summary };
}

test("exposes installed pi-cohort model fallback and completion guard runtimes", async () => {
  const runtime = await loadCohortRuntime();
  assert.deepEqual(
    runtime.modelFallback.buildModelCandidates("provider/primary", ["provider/backup", "provider/primary"]),
    ["provider/primary", "provider/backup"],
  );
  assert.equal(runtime.modelFallback.isRetryableModelFailure("provider overloaded"), true);
  assert.equal(runtime.modelFallback.isRetryableModelFailure("invalid task input"), false);
  assert.equal(runtime.completionGuard.evaluateCompletionMutationGuard({
    agent: "worker", task: "implement the fix", messages: [],
  }).triggered, true);
  assert.equal(runtime.completionGuard.evaluateCompletionMutationGuard({
    agent: "worker", task: "implement the fix", messages: [], tools: ["read", "grep"],
  }).triggered, false);
});

test("uses pi-cohort structured output runtime for valid, missing, and invalid submissions", async () => {
  const runtime = await loadCohortRuntime();
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  };

  const valid = runtime.structured.createStructuredOutputRuntime(schema);
  writeFileSync(valid.outputPath, JSON.stringify({ answer: "yes" }));
  assert.deepEqual((await finalizePaneOutcome(completion(), {
    cwd: process.cwd(), agentName: "scout", task: "inspect", structuredRuntime: valid,
  }, runtime)).structuredOutput, { answer: "yes" });

  const missing = runtime.structured.createStructuredOutputRuntime(schema);
  assert.match((await finalizePaneOutcome(completion(), {
    cwd: process.cwd(), agentName: "scout", task: "inspect", structuredRuntime: missing,
  }, runtime)).errorMessage ?? "", /Missing structured_output call/);

  const invalid = runtime.structured.createStructuredOutputRuntime(schema);
  writeFileSync(invalid.outputPath, JSON.stringify({ answer: 42 }));
  assert.match((await finalizePaneOutcome(completion(), {
    cwd: process.cwd(), agentName: "scout", task: "inspect", structuredRuntime: invalid,
  }, runtime)).errorMessage ?? "", /Structured output validation failed: answer/);
});

test("runs acceptance verification with cwd, env, timeout, and allowFailure semantics", async () => {
  const runtime = await loadCohortRuntime();
  const cwd = mkdtempSync(join(tmpdir(), "cohort-bridge-acceptance-"));
  writeFileSync(join(cwd, "marker"), "ok");
  const report = "```acceptance-report\n{\"criteriaSatisfied\":[{\"id\":\"criterion-1\",\"status\":\"satisfied\",\"evidence\":\"inspected\"}],\"changedFiles\":[\"result.txt\"],\"testsAddedOrUpdated\":[\"test.txt\"],\"commandsRun\":[{\"command\":\"test\",\"result\":\"passed\",\"summary\":\"ok\"}],\"validationOutput\":[\"ok\"],\"residualRisks\":[],\"noStagedFiles\":true}\n```";
  const finalized = await finalizePaneOutcome(completion(report), {
    cwd,
    agentName: "scout",
    task: "inspect",
    acceptance: {
      level: "verified",
      criteria: [],
      evidence: ["residual-risks"],
      verify: [
        { id: "env-cwd", command: "test \"$PANE_VALUE\" = yes && test -f marker", env: { PANE_VALUE: "yes" } },
        { id: "allowed", command: "exit 7", allowFailure: true },
      ],
    },
  }, runtime);

  assert.equal(finalized.errorMessage, undefined);
  assert.equal(finalized.acceptance?.status, "verified");
  assert.deepEqual(finalized.acceptance?.verifyRuns.map((run: { status: string }) => run.status), ["passed", "allowed-failure"]);
});

test("infers reviewed acceptance for an ordinary async worker when acceptance is omitted", async () => {
  const runtime = await loadCohortRuntime();
  const report = "```acceptance-report\n{\"criteriaSatisfied\":[{\"id\":\"criterion-1\",\"status\":\"satisfied\",\"evidence\":\"implemented\"},{\"id\":\"criterion-2\",\"status\":\"satisfied\",\"evidence\":\"review evidence\"}],\"changedFiles\":[\"source.ts\"],\"testsAddedOrUpdated\":[\"test.ts\"],\"commandsRun\":[{\"command\":\"test\",\"result\":\"passed\",\"summary\":\"ok\"}],\"validationOutput\":[\"ok\"],\"residualRisks\":[],\"noStagedFiles\":true}\n```";
  let launches = 0;
  const finalized = await finalizePaneOutcome(completion(report), {
    cwd: process.cwd(), agentName: "worker", task: "implement the fix",
  }, runtime, async () => {
    launches++;
    return { status: "no-blockers", findings: [] };
  });

  assert.equal(launches, 1);
  assert.equal(finalized.acceptance?.effectiveAcceptance.level, "reviewed");
  assert.equal(finalized.acceptance?.effectiveAcceptance.review.required, true);
  assert.equal(finalized.acceptance?.status, "reviewed");
});

test("preserves explicit false acceptance as none without launching a reviewer", async () => {
  const runtime = await loadCohortRuntime();
  let launches = 0;
  const finalized = await finalizePaneOutcome(completion("done"), {
    cwd: process.cwd(), agentName: "worker", task: "implement", acceptance: false,
  }, runtime, async () => { launches++; return { status: "no-blockers", findings: [] }; });
  assert.equal(launches, 0);
  assert.equal(finalized.acceptance?.status, "not-required");
});

test("fails explicit reviewer rejection but keeps inferred rejection advisory", async () => {
  const runtime = await loadCohortRuntime();
  const report = "```acceptance-report\n{\"criteriaSatisfied\":[{\"id\":\"criterion-1\",\"status\":\"satisfied\",\"evidence\":\"implemented\"},{\"id\":\"criterion-2\",\"status\":\"satisfied\",\"evidence\":\"review evidence\"}],\"changedFiles\":[\"source.ts\"],\"testsAddedOrUpdated\":[\"test.ts\"],\"commandsRun\":[{\"command\":\"test\",\"result\":\"passed\",\"summary\":\"ok\"}],\"validationOutput\":[\"ok\"],\"residualRisks\":[],\"noStagedFiles\":true}\n```";
  let launches = 0;
  const cases = [
    {
      acceptance: { level: "reviewed", criteria: [], evidence: ["residual-risks"], review: { required: true, agent: "disabled-reviewer" } },
      reviewer: "disabled-reviewer",
      exitCode: 1,
    },
    { acceptance: undefined, reviewer: "reviewer", exitCode: 0 },
  ];
  for (const scenario of cases) {
    const finalized = await finalizePaneOutcome(completion(report), {
      cwd: process.cwd(), agentName: "worker", task: "implement",
      acceptance: scenario.acceptance,
      reviewerValidator: (agent) => `Reviewer agent '${agent}' is disabled.`,
    }, runtime, async () => { launches++; return { status: "no-blockers", findings: [] }; });

    assert.equal(finalized.acceptance?.status, "rejected");
    assert.equal(finalized.acceptance?.explicit, scenario.acceptance !== undefined);
    assert.equal(finalized.exitCode, scenario.exitCode);
    if (scenario.acceptance === undefined) {
      assert.equal(finalized.errorMessage, undefined);
    } else {
      assert.match(finalized.errorMessage ?? "", new RegExp(`Reviewer agent '${scenario.reviewer}' is disabled\\.`));
    }
  }
  assert.equal(launches, 0);
});

test("launches required acceptance reviewer through the supplied pane runner and enforces blockers", async () => {
  const runtime = await loadCohortRuntime();
  const report = "```acceptance-report\n{\"criteriaSatisfied\":[{\"id\":\"criterion-1\",\"status\":\"satisfied\",\"evidence\":\"implemented\"},{\"id\":\"criterion-2\",\"status\":\"satisfied\",\"evidence\":\"evidence returned\"}],\"changedFiles\":[\"source.ts\"],\"testsAddedOrUpdated\":[\"test.ts\"],\"commandsRun\":[{\"command\":\"test\",\"result\":\"passed\",\"summary\":\"ok\"}],\"validationOutput\":[\"ok\"],\"residualRisks\":[],\"noStagedFiles\":true}\n```";
  let launches = 0;
  const finalized = await finalizePaneOutcome(completion(report), {
    cwd: process.cwd(),
    agentName: "worker",
    task: "implement",
    acceptance: { level: "reviewed", criteria: [], evidence: ["residual-risks"], review: { required: true, agent: "reviewer" } },
  }, runtime, async (request) => {
    launches++;
    assert.equal(request.agent, "reviewer");
    assert.equal(request.backend, "pane");
    return { status: "blockers", findings: [{ severity: "blocker", issue: "broken", rationale: "test" }] };
  });

  assert.equal(launches, 1);
  assert.equal(finalized.acceptance?.status, "rejected");
  assert.match(finalized.errorMessage ?? "", /review found blockers/i);
});

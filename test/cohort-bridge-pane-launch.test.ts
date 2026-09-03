/**
 * Regression test for the pane launch-script generation path.
 *
 * buildPaneLaunchCommand() and its unit tests (cohort-bridge-routing.test.ts)
 * only exercise the helper in isolation. That left a real production bug
 * unnoticed: runSubagentInPane() built its own inline command string instead
 * of calling the helper, so every pane's launch.sh invoked bare `pi` without
 * access to the parent process's resolved credentials. The child pane then
 * exited in ~5s with no session or output.
 *
 * These tests exercise the actual runSubagentInPane() launch path (via the
 * __test__ surface) with the real cmux surface/exit-poll calls mocked out.
 * Resolved parent credentials cross through a one-shot FIFO; a pane falls back
 * to the retention-mode fish launcher only when the parent has none.
 */
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CMUX_MODULE_URL = pathToFileURL(
  join(import.meta.dirname, "..", "pi-extension", "subagents", "cmux.ts"),
).href;

let capturedCommand: string | undefined;
let credentialFifoMode: number | undefined;
let credentialPayload: string | undefined;
let credentialRead: Promise<string> | undefined;
let commandExecution: Promise<number> | undefined;
let executeCommand = false;
let closeCalls = 0;
let surfaceCount = 0;
let paneEvents: string[] = [];

describe("cohort-bridge pane launch script generation", () => {
  let cwd: string;
  let agentDir: string;
  let bridge: typeof import("../pi-extension/cohort-bridge.ts");

  before(async () => {
    // AGENT_DIR is computed once at module load from PI_CODING_AGENT_DIR, so
    // it must be set before cohort-bridge.ts is first imported. basename
    // must be a recognized preset directory (see resolvePaneLauncher).
    agentDir = mkdtempSync(join(tmpdir(), "cohort-bridge-pane-launch-"));
    const presetDir = join(agentDir, "agent.balanced");
    process.env.PI_CODING_AGENT_DIR = presetDir;

    const real = await import("../pi-extension/subagents/cmux.ts");
    mock.module(CMUX_MODULE_URL, {
      namedExports: {
        isMuxAvailable: real.isMuxAvailable,
        getMuxBackend: real.getMuxBackend,
        muxPreference: real.muxPreference,
        muxSetupHint: real.muxSetupHint,
        shellEscape: real.shellEscape,
        readScreen: () => "",
        createSurface: () => {
          const surface = `surface:${++surfaceCount}`;
          paneEvents.push(`create:${surface}`);
          return surface;
        },
        sendLongCommand: (surface: string, command: string, options?: { scriptPath?: string }) => {
          capturedCommand = command;
          const credentialFifo = command.match(/(\/[^' ]*cohort-bridge-credentials-[^' ]*\/credentials\.fifo)/)?.[1];
          if (credentialFifo) {
            credentialFifoMode = statSync(credentialFifo).mode & 0o777;
            if (executeCommand) {
              commandExecution = new Promise((resolve) => {
                execFile("/bin/bash", ["-c", command], (error) => {
                  resolve(error && typeof error.code === "number" ? error.code : 0);
                });
              });
            } else {
              credentialRead = new Promise((resolve, reject) => {
                execFile("cat", [credentialFifo], { encoding: "utf8" }, (error, stdout) => {
                  if (error) reject(error);
                  else resolve(stdout);
                });
              });
            }
          }
          paneEvents.push(`send:${surface}`);
          if (options?.scriptPath) writeFileSync(options.scriptPath, command);
        },
        pollForExit: async () => {
          if (credentialRead) credentialPayload = await credentialRead;
          return { exitCode: commandExecution ? await commandExecution : 0 };
        },
        closeSurface: (surface: string) => {
          closeCalls++;
          paneEvents.push(`close:${surface}`);
        },
      },
    });

    bridge = await import("../pi-extension/cohort-bridge.ts");
  });

  beforeEach(() => {
    capturedCommand = undefined;
    credentialFifoMode = undefined;
    credentialPayload = undefined;
    credentialRead = undefined;
    commandExecution = undefined;
    executeCommand = false;
    closeCalls = 0;
    surfaceCount = 0;
    paneEvents = [];
    bridge.__test__.resetForTest();
    bridge.__test__.setPaneLifecycleHooks({
      loadRuntime: async () => ({
        acceptance: {
          resolveEffectiveAcceptance: () => ({ level: "attested", explicit: false, inferredReason: [], criteria: [], evidence: [], verify: [], stopRules: [] }),
          formatAcceptancePrompt: () => "\n## Acceptance Contract\nAcceptance level: attested",
          evaluateAcceptance: async ({ acceptance }: any) => ({ status: "attested", effectiveAcceptance: acceptance, runtimeChecks: [], verifyRuns: [] }),
          acceptanceFailureMessage: () => undefined,
        },
      } as any),
      credentialEnvironment: () => ({}),
    });
    cwd = mkdtempSync(join(tmpdir(), "cohort-bridge-pane-launch-cwd-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("hands resolved credentials to the pane through a 0600 FIFO", async () => {
    const secretSentinel = "credential-sentinel-must-not-appear-in-launch-artifacts";
    bridge.__test__.setPaneLifecycleHooks({
      credentialEnvironment: () => ({
        ANTHROPIC_API_KEY: secretSentinel,
        KAGI_API_KEY: "kagi-sentinel",
      }),
    });

    const outcome = await bridge.__test__.runSubagentInPane({
      runId: "credential-handoff",
      index: 0,
      name: "worker",
      task: "say hello",
      agent: "worker",
      cwd,
      orchestratorTarget: "test-target",
    });

    assert.equal(outcome.exitCode, 0);
    assert.equal(credentialFifoMode, 0o600);
    assert.match(credentialPayload ?? "", /export ANTHROPIC_API_KEY=/);
    assert.match(credentialPayload ?? "", new RegExp(secretSentinel));
    assert.match(credentialPayload ?? "", /export KAGI_API_KEY=/);
    const credentialFifo = capturedCommand?.match(
      /(\/[^' ]*cohort-bridge-credentials-[^' ]*\/credentials\.fifo)/,
    )?.[1];
    assert.ok(credentialFifo);
    assert.equal(existsSync(credentialFifo), false);
    assert.match(capturedCommand ?? "", /\bpi\s+--session/);
    assert.doesNotMatch(capturedCommand ?? "", /pi-balanced/);
    assert.doesNotMatch(capturedCommand ?? "", new RegExp(secretSentinel));
    const launchArtifact = readFileSync(
      join(agentDir, "agent.balanced", "artifacts", "credential-handoff", "child-0", "launch.sh"),
      "utf8",
    );
    assert.match(launchArtifact, /credentials\.fifo/);
    assert.doesNotMatch(launchArtifact, new RegExp(secretSentinel));
  });

  it("removes the credential FIFO when pane launch fails", async () => {
    let credentialFifo: string | undefined;
    bridge.__test__.setPaneLifecycleHooks({
      credentialEnvironment: () => ({ ANTHROPIC_API_KEY: "anthropic-sentinel" }),
      send: (_surface, command) => {
        credentialFifo = command.match(
          /(\/[^' ]*cohort-bridge-credentials-[^' ]*\/credentials\.fifo)/,
        )?.[1];
        throw new Error("send failed");
      },
    });

    const outcome = await bridge.__test__.runSubagentInPane({
      runId: "credential-send-failure",
      index: 0,
      name: "worker",
      task: "say hello",
      agent: "worker",
      cwd,
      orchestratorTarget: "test-target",
    });

    assert.match(outcome.errorMessage ?? "", /send failed/);
    assert.ok(credentialFifo);
    assert.equal(existsSync(credentialFifo), false);
  });

  it("loads FIFO credentials before invoking raw pi", async () => {
    const fakeBin = join(cwd, "bin");
    const credentialResult = join(cwd, "credential-result");
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "pi"), [
      "#!/bin/sh",
      'test -n "$ANTHROPIC_API_KEY" || exit 11',
      'test -n "$KAGI_API_KEY" || exit 12',
      'printf received > "$CREDENTIAL_RESULT"',
    ].join("\n") + "\n", { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${previousPath}`;
    process.env.CREDENTIAL_RESULT = credentialResult;
    executeCommand = true;
    bridge.__test__.setPaneLifecycleHooks({
      credentialEnvironment: () => ({
        ANTHROPIC_API_KEY: "anthropic-sentinel",
        KAGI_API_KEY: "kagi-sentinel",
      }),
    });

    try {
      const outcome = await bridge.__test__.runSubagentInPane({
        runId: "credential-runtime",
        index: 0,
        name: "worker",
        task: "say hello",
        agent: "worker",
        cwd,
        orchestratorTarget: "test-target",
      });
      assert.equal(outcome.exitCode, 0);
      assert.equal(readFileSync(credentialResult, "utf8"), "received");
    } finally {
      process.env.PATH = previousPath;
      delete process.env.CREDENTIAL_RESULT;
    }
  });

  it("bounds the FIFO read before launching pi", () => {
    const handoffDir = mkdtempSync(join(tmpdir(), "cohort-bridge-timeout-"));
    const credentialFifo = join(handoffDir, "credentials.fifo");
    execFileSync("mkfifo", [credentialFifo]);
    const command = bridge.buildPaneLaunchCommand(
      join(agentDir, "agent.balanced"),
      cwd,
      [],
      ["--session", "child.jsonl"],
      credentialFifo,
      0.1,
    );

    try {
      assert.match(command, /read .* -t 0\.1 .*credential_payload/);
      assert.match(command, /Credential handoff timed out/);
      const output = execFileSync("/bin/bash", ["-c", command], {
        encoding: "utf8",
        timeout: 2_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.match(output, /__SUBAGENT_DONE_1__/);
    } finally {
      rmSync(handoffDir, { recursive: true, force: true });
    }
  });

  it("redacts handed-off credential values from pane failures", async () => {
    const secretSentinel = "bare-credential-sentinel-must-be-redacted";
    bridge.__test__.setPaneLifecycleHooks({
      credentialEnvironment: () => ({ KAGI_API_KEY: secretSentinel }),
      send: () => "",
      poll: async () => ({
        exitCode: 1,
        reason: "error" as const,
        errorMessage: `provider failed with ${secretSentinel}`,
      }),
    });

    const outcome = await bridge.__test__.runSubagentInPane({
      runId: "credential-redaction",
      index: 0,
      name: "worker",
      task: "say hello",
      agent: "worker",
      cwd,
      orchestratorTarget: "test-target",
    });

    assert.doesNotMatch(outcome.summary, new RegExp(secretSentinel));
    assert.doesNotMatch(outcome.errorMessage ?? "", new RegExp(secretSentinel));
    assert.match(outcome.errorMessage ?? "", /\[REDACTED\]/);
  });

  it("returns fork seeding failures through the normal child outcome", async () => {
    const outcome = await bridge.__test__.runSubagentInPane({
      runId: "fork-failure",
      index: 0,
      name: "worker",
      task: "say hello",
      agent: "worker",
      cwd,
      context: "fork",
      parentSessionFile: join(cwd, "missing-parent.jsonl"),
      orchestratorTarget: "test-target",
    });
    assert.equal(outcome.exitCode, null);
    assert.match(outcome.errorMessage ?? "", /missing-parent|ENOENT|session/i);
  });

  it("closes panes and removes live/temporary state when send, poll, or finalization throws", async () => {
    const base = { runId: "lifecycle", index: 0, name: "worker", task: "work", agent: "worker", cwd, orchestratorTarget: "target" };

    bridge.__test__.setPaneLifecycleHooks({ send: () => { throw new Error("send failed"); } });
    assert.match((await bridge.__test__.runSubagentInPane(base)).errorMessage ?? "", /send failed/);

    bridge.__test__.resetForTest();
    bridge.__test__.setPaneLifecycleHooks({
      loadRuntime: async () => ({
        acceptance: {
          resolveEffectiveAcceptance: () => ({ level: "attested", explicit: false, inferredReason: [], criteria: [], evidence: [], verify: [], stopRules: [] }),
          formatAcceptancePrompt: () => "",
        },
      } as any),
      poll: async () => { throw new Error("poll failed"); },
      credentialEnvironment: () => ({}),
    });
    assert.match((await bridge.__test__.runSubagentInPane({ ...base, runId: "poll" })).errorMessage ?? "", /poll failed/);

    bridge.__test__.resetForTest();
    const tempBefore = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("cohort-bridge-")));
    bridge.__test__.setPaneLifecycleHooks({
      loadRuntime: async () => ({
        acceptance: {
          resolveEffectiveAcceptance: () => ({ level: "attested", explicit: false, inferredReason: [], criteria: [], evidence: [], verify: [], stopRules: [] }),
          formatAcceptancePrompt: () => "",
        },
        structured: {
          createStructuredOutputRuntime: (_schema: unknown, baseDir: string) => {
            const dir = mkdtempSync(join(baseDir, "pi-subagent-structured-"));
            return { schemaPath: join(dir, "schema.json"), outputPath: join(dir, "output.json") };
          },
          cleanupStructuredOutputRuntime: (runtime: { outputPath: string }) => rmSync(join(runtime.outputPath, ".."), { recursive: true, force: true }),
          STRUCTURED_OUTPUT_SCHEMA_ENV: "PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA",
          STRUCTURED_OUTPUT_CAPTURE_ENV: "PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE",
        },
      } as any),
      finalize: async () => { throw new Error("finalize failed"); },
      credentialEnvironment: () => ({}),
    });
    const finalized = await bridge.__test__.runSubagentInPane({
      ...base, runId: "finalize", outputSchema: { type: "object" },
      persona: { filePath: "worker.md", systemPromptMode: "replace", inheritProjectContext: true, inheritSkills: false, systemPrompt: "worker prompt" },
    });
    assert.match(finalized.errorMessage ?? "", /finalize failed/);
    assert.equal(closeCalls, 3);
    assert.equal(bridge.__test__.buildStatusAugmentation({ action: "status" }, []), undefined);
    const tempAfter = readdirSync(tmpdir()).filter((name) => name.startsWith("cohort-bridge-") && !tempBefore.has(name));
    assert.deepEqual(tempAfter, []);
    const childArtifact = join(agentDir, "agent.balanced", "artifacts", "finalize", "child-0");
    assert.equal(readdirSync(childArtifact).some((name) => name.startsWith("pi-subagent-structured-")), false);
  });

  it("retries retryable model failures in persona fallback order but not non-retryable failures", async () => {
    const commands: string[] = [];
    let attempts = 0;
    bridge.__test__.setPaneLifecycleHooks({
      loadRuntime: async () => ({
        acceptance: {
          resolveEffectiveAcceptance: () => ({ level: "attested", explicit: false, inferredReason: [], criteria: [], evidence: [], verify: [], stopRules: [] }),
          formatAcceptancePrompt: () => "",
          evaluateAcceptance: async ({ acceptance }: any) => ({ status: "attested", effectiveAcceptance: acceptance, runtimeChecks: [], verifyRuns: [] }),
          acceptanceFailureMessage: () => undefined,
        },
        modelFallback: {
          buildModelCandidates: (primary: string, fallbacks: string[]) => [primary, ...(fallbacks ?? [])],
          isRetryableModelFailure: (error: string) => /overloaded|rate limit|auth|429/i.test(error),
          formatModelAttemptNote: (attempt: any, next: string) => `[fallback] ${attempt.model} failed: ${attempt.error}. Retrying with ${next}.`,
        },
      } as any),
      send: (_surface, command) => { commands.push(command); return command; },
      poll: async (_surface, _signal, options) => {
        attempts++;
        writeFileSync(options.sessionFile!,  `${JSON.stringify({ type: "session", id: `s-${attempts}` })}\n${JSON.stringify({ type: "message", id: `m-${attempts}`, message: { role: "assistant", content: [], stopReason: "error", errorMessage: attempts === 1 ? "provider overloaded" : "bad task input" } })}\n`);
        return { exitCode: 1, reason: "done" as const };
      },
    });
    const persona = {
      filePath: "worker.md", model: "provider/primary", fallbackModels: ["provider/backup", "provider/unused"],
      systemPromptMode: "replace" as const, inheritProjectContext: true, inheritSkills: false,
      systemPrompt: "", tools: ["read"],
    };
    const outcome = await bridge.__test__.runSubagentInPane({
      runId: "fallback", index: 0, name: "worker", task: "inspect", agent: "worker", cwd,
      persona, orchestratorTarget: "target",
    });

    assert.equal(attempts, 2, "non-retryable second failure must stop fallback");
    assert.match(commands[0]!, /provider\/primary/);
    assert.match(commands[1]!, /provider\/backup/);
    assert.doesNotMatch(commands.join("\n"), /provider\/unused/);
    assert.match(outcome.summary, /\[fallback\].*provider\/primary.*provider\/backup/s);
    assert.match(outcome.attemptDiagnostics ?? "", /\[fallback\].*provider\/primary.*provider\/backup/s);
    assert.equal(outcome.attemptDiagnostics?.match(/\[fallback\]/g)?.length, 1);
    assert.doesNotMatch(outcome.attemptDiagnostics ?? "", /bad task input/);
    assert.equal(outcome.summary.match(/bad task input/g)?.length, 1);
  });

  it("delivers every sidecar model failure in order without raw provider secrets", async () => {
    const models = ["anthropic/primary", "amazon-bedrock/fallback"];
    const secretSentinel = "credential-sentinel-must-not-appear-1234567890";
    const rawErrors = [
      `Provider request failed with status 401: x-api-key: ${secretSentinel}`,
      `Provider request failed with status 403: model access denied Authorization: Bearer ${secretSentinel}`,
    ];
    let attempts = 0;
    bridge.__test__.setPaneLifecycleHooks({
      loadRuntime: async () => ({
        acceptance: {
          resolveEffectiveAcceptance: () => ({ level: "attested", explicit: false, inferredReason: [], criteria: [], evidence: [], verify: [], stopRules: [] }),
          formatAcceptancePrompt: () => "",
          evaluateAcceptance: async ({ acceptance }: any) => ({ status: "attested", effectiveAcceptance: acceptance, runtimeChecks: [], verifyRuns: [] }),
          acceptanceFailureMessage: () => undefined,
        },
        modelFallback: {
          buildModelCandidates: () => models,
          isRetryableModelFailure: () => false,
          formatModelAttemptNote: (attempt: any, next?: string) =>
            `[fallback] ${attempt.model} failed: ${attempt.error}.${next ? ` Retrying with ${next}.` : ""}`,
        },
      } as any),
      poll: async () => ({
        exitCode: 1,
        reason: "error" as const,
        errorMessage: rawErrors[attempts++],
      }),
    });
    const spec = {
      runId: "sidecar-failures", index: 0, name: "worker", task: "inspect", agent: "worker", cwd,
      persona: {
        filePath: "worker.md", model: models[0], fallbackModels: models.slice(1),
        systemPromptMode: "replace" as const, inheritProjectContext: true, inheritSkills: false,
        systemPrompt: "", tools: ["read"],
      },
      orchestratorTarget: "target",
    };
    const outcome = await bridge.__test__.runSubagentInPane(spec);
    const outcomeText = `${outcome.summary}\n${outcome.errorMessage ?? ""}\n${outcome.attemptDiagnostics ?? ""}`;
    assert.match(outcomeText, /anthropic\/primary/);
    assert.match(outcomeText, /amazon-bedrock\/fallback/);
    assert.match(outcomeText, /status 401/);
    assert.match(outcomeText, /status 403/);
    assert.doesNotMatch(outcome.summary, new RegExp(secretSentinel));
    assert.doesNotMatch(outcome.errorMessage ?? "", new RegExp(secretSentinel));
    assert.doesNotMatch(outcome.attemptDiagnostics ?? "", new RegExp(secretSentinel));

    attempts = 0;
    const delivered: any[] = [];
    await bridge.__test__.dispatchSingle(
      { sendMessage: (message: any) => delivered.push(message) } as any,
      { isIdle: () => true } as any,
      spec,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(attempts, 2);
    assert.equal(delivered.length, 1);
    const content = delivered[0].content as string;
    assert.match(content, new RegExp(`${models[0]}.*status 401.*${models[1]}.*status 403`, "s"));
    assert.match(content, /x-api-key: \[REDACTED\]/);
    assert.match(content, /Authorization: Bearer \[REDACTED\]/);
    assert.doesNotMatch(content, new RegExp(secretSentinel));
    assert.equal(content.match(/\[fallback\]/g)?.length, 2);
    assert.equal(content.match(/anthropic\/primary failed/g)?.length, 1);
    assert.equal(content.match(/amazon-bedrock\/fallback failed/g)?.length, 1);
    assert.equal(content.match(/Provider request failed with status 401/g)?.length, 1);
    assert.equal(content.match(/Provider request failed with status 403/g)?.length, 2);
    assert.match(content, /Error: Provider request failed with status 403: model access denied Authorization: Bearer \[REDACTED\]$/);
  });

  it("advances from missing Anthropic auth to a successful configured fallback", async () => {
    const outcome = await runPermanentFailureScenario(
      ["No API key available for Anthropic", undefined],
      ["anthropic/primary", "amazon-bedrock/fallback"],
    );

    assert.equal(outcome.exitCode, 0);
    assert.deepEqual(outcome.attemptedModels, ["anthropic/primary", "amazon-bedrock/fallback"]);
    assert.match(outcome.summary, /anthropic\/primary.*No API key available for Anthropic.*amazon-bedrock\/fallback/s);
  });

  it("advances from an unavailable model to a successful configured fallback", async () => {
    const outcome = await runPermanentFailureScenario(
      ["Model anthropic/blarg-fake is unavailable", undefined],
      ["anthropic/blarg-fake", "github-copilot/backup"],
    );

    assert.equal(outcome.exitCode, 0);
    assert.deepEqual(outcome.attemptedModels, ["anthropic/blarg-fake", "github-copilot/backup"]);
  });

  it("advances through two permanent failures before the third candidate succeeds", async () => {
    const outcome = await runPermanentFailureScenario(
      ["Authentication rejected", "Model backup/denied is not accessible", undefined],
      ["anthropic/primary", "backup/denied", "backup/success"],
    );

    assert.equal(outcome.exitCode, 0);
    assert.deepEqual(outcome.attemptedModels, ["anthropic/primary", "backup/denied", "backup/success"]);
    assert.equal(closeCalls, 3);
  });

  it("returns a permanent failure immediately when no fallback is configured", async () => {
    const outcome = await runPermanentFailureScenario(
      ["No credentials configured for Anthropic"],
      ["anthropic/primary"],
    );

    assert.equal(outcome.exitCode, 1);
    assert.deepEqual(outcome.attemptedModels, ["anthropic/primary"]);
    assert.match(outcome.errorMessage ?? outcome.summary, /No credentials configured/);
  });

  it("does not advance for an unrelated task-input failure", async () => {
    const outcome = await runPermanentFailureScenario(
      ["Task input did not match the requested schema", undefined],
      ["provider/primary", "provider/fallback"],
    );

    assert.equal(outcome.exitCode, 1);
    assert.deepEqual(outcome.attemptedModels, ["provider/primary"]);
  });

  it("closes each permanently failed pane before launching its fallback", async () => {
    const outcome = await runPermanentFailureScenario(
      ["HTTP 401 unauthorized", undefined],
      ["anthropic/primary", "backup/success"],
    );

    assert.equal(outcome.exitCode, 0);
    assert.deepEqual(paneEvents, [
      "create:surface:1", "send:surface:1:anthropic/primary", "close:surface:1",
      "create:surface:2", "send:surface:2:backup/success", "close:surface:2",
    ]);
    assert.equal(new Set(outcome.sessionFiles).size, 2, "each candidate must use a fresh session");
  });

  it("reports failed models and messages without exposing a credential sentinel", async () => {
    const secretSentinel = "credential-sentinel-must-not-appear";
    process.env.ANTHROPIC_API_KEY = secretSentinel;
    try {
      const outcome = await runPermanentFailureScenario(
        ["No API key available for Anthropic", "Model backup/missing is not found"],
        ["anthropic/primary", "backup/missing"],
      );
      const diagnostics = `${outcome.summary}\n${outcome.errorMessage ?? ""}`;

      assert.equal(outcome.exitCode, 1);
      assert.match(diagnostics, /anthropic\/primary.*No API key available for Anthropic/s);
      assert.match(diagnostics, /backup\/missing.*Model backup\/missing is not found/s);
      assert.doesNotMatch(diagnostics, new RegExp(secretSentinel));
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  async function runPermanentFailureScenario(
    failures: Array<string | undefined>,
    models: string[],
  ) {
    const attemptedModels: string[] = [];
    const sessionFiles: string[] = [];
    bridge.__test__.setPaneLifecycleHooks({
      loadRuntime: async () => ({
        acceptance: {
          resolveEffectiveAcceptance: () => ({ level: "attested", explicit: false, inferredReason: [], criteria: [], evidence: [], verify: [], stopRules: [] }),
          formatAcceptancePrompt: () => "",
          evaluateAcceptance: async ({ acceptance }: any) => ({ status: "attested", effectiveAcceptance: acceptance, runtimeChecks: [], verifyRuns: [] }),
          acceptanceFailureMessage: () => undefined,
        },
        modelFallback: {
          buildModelCandidates: () => models,
          isRetryableModelFailure: () => false,
          formatModelAttemptNote: (attempt: any, next: string) =>
            `[fallback] ${attempt.model} failed: ${attempt.error}. Retrying with ${next}.`,
        },
      } as any),
      send: (surface, command) => {
        const model = models.find((candidate) => command.includes(candidate));
        assert.ok(model, `expected command to contain one of: ${models.join(", ")}`);
        attemptedModels.push(model);
        paneEvents.push(`send:${surface}:${model}`);
        return command;
      },
      poll: async (_surface, _signal, options) => {
        sessionFiles.push(options.sessionFile!);
        const attempt = attemptedModels.length - 1;
        const failure = failures[attempt];
        writeFileSync(options.sessionFile!, `${JSON.stringify({
          type: "message",
          id: `m-${attempt}`,
          message: {
            role: "assistant",
            content: failure ? [] : [{ type: "text", text: "completed" }],
            stopReason: failure ? "error" : "stop",
            ...(failure ? { errorMessage: failure } : {}),
          },
        })}\n`);
        return { exitCode: failure ? 1 : 0, reason: "done" as const };
      },
    });

    return resultWithAttempts(attemptedModels, sessionFiles, await bridge.__test__.runSubagentInPane({
      runId: `permanent-${Math.random()}`, index: 0, name: "worker", task: "inspect", agent: "worker", cwd,
      persona: {
        filePath: "worker.md", model: models[0], fallbackModels: models.slice(1),
        systemPromptMode: "replace", inheritProjectContext: true, inheritSkills: false,
        systemPrompt: "", tools: ["read"],
      },
      orchestratorTarget: "target",
    }));
  }

  function resultWithAttempts(
    attemptedModels: string[],
    sessionFiles: string[],
    outcome: Awaited<ReturnType<typeof bridge.__test__.runSubagentInPane>>,
  ) {
    return { ...outcome, attemptedModels, sessionFiles };
  }

  it("enforces pi-cohort's completion mutation guard and honors its read-only tools exemption", async () => {
    bridge.__test__.setPaneLifecycleHooks({
      loadRuntime: async () => ({
        acceptance: {
          resolveEffectiveAcceptance: () => ({ level: "attested", explicit: false, inferredReason: [], criteria: [], evidence: [], verify: [], stopRules: [] }),
          formatAcceptancePrompt: () => "",
          evaluateAcceptance: async ({ acceptance }: any) => ({ status: "attested", effectiveAcceptance: acceptance, runtimeChecks: [], verifyRuns: [] }),
          acceptanceFailureMessage: () => undefined,
        },
        modelFallback: { buildModelCandidates: () => [], isRetryableModelFailure: () => false, formatModelAttemptNote: () => "" },
        completionGuard: {
          evaluateCompletionMutationGuard: ({ task, tools }: any) => ({
            triggered: /implement|fix|edit/i.test(task) && !(tools?.length && tools.every((tool: string) => ["read", "grep", "find", "ls"].includes(tool))),
          }),
        },
      } as any),
      poll: async (_surface, _signal, options) => {
        writeFileSync(options.sessionFile!,  `${JSON.stringify({ type: "session", id: "s" })}\n${JSON.stringify({ type: "message", id: "m", message: { role: "assistant", content: [{ type: "text", text: "planned it" }] } })}\n`);
        return { exitCode: 0, reason: "done" as const };
      },
    });
    const persona = {
      filePath: "worker.md", systemPromptMode: "replace" as const, inheritProjectContext: true,
      inheritSkills: false, systemPrompt: "",
    };
    const guarded = await bridge.__test__.runSubagentInPane({
      runId: "guarded", index: 0, name: "worker", task: "implement the fix", agent: "worker", cwd,
      persona, orchestratorTarget: "target",
    });
    assert.equal(guarded.exitCode, 1);
    assert.match(guarded.errorMessage ?? "", /completed without making edits/);

    const exempt = await bridge.__test__.runSubagentInPane({
      runId: "exempt", index: 0, name: "worker", task: "implement the fix", agent: "worker", cwd,
      persona: { ...persona, tools: ["read", "grep"] }, orchestratorTarget: "target",
    });
    assert.equal(exempt.exitCode, 0);
    assert.equal(exempt.errorMessage, undefined);
  });

  it("scopes the completion mutation guard to forked child entries", async () => {
    const parentSessionFile = join(cwd, "parent.jsonl");
    writeFileSync(parentSessionFile, [
      { type: "session", id: "parent-session" },
      { type: "message", id: "parent-edit", message: { role: "assistant", content: [{ type: "toolCall", name: "edit" }] } },
      { type: "message", id: "parent-result", message: { role: "toolResult", content: [{ type: "text", text: "edited" }] } },
      { type: "message", id: "parent-user", message: { role: "user", content: [{ type: "text", text: "delegate the rest" }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

    let guardedMessages: any[] = [];
    bridge.__test__.setPaneLifecycleHooks({
      loadRuntime: async () => ({
        acceptance: {
          resolveEffectiveAcceptance: () => ({ level: "attested", explicit: false, inferredReason: [], criteria: [], evidence: [], verify: [], stopRules: [] }),
          formatAcceptancePrompt: () => "",
          evaluateAcceptance: async ({ acceptance }: any) => ({ status: "attested", effectiveAcceptance: acceptance, runtimeChecks: [], verifyRuns: [] }),
          acceptanceFailureMessage: () => undefined,
        },
        modelFallback: { buildModelCandidates: () => [], isRetryableModelFailure: () => false, formatModelAttemptNote: () => "" },
        completionGuard: {
          evaluateCompletionMutationGuard: ({ messages }: any) => {
            guardedMessages = messages;
            const attemptedMutation = messages.some((message: any) =>
              message.content?.some((block: any) => block.type === "toolCall" && block.name === "edit"),
            );
            return { triggered: !attemptedMutation };
          },
        },
      } as any),
      poll: async (_surface, _signal, options) => {
        appendFileSync(options.sessionFile!, JSON.stringify({
          type: "message", id: "child-answer",
          message: { role: "assistant", content: [{ type: "text", text: "no changes needed" }] },
        }) + "\n");
        return { exitCode: 0, reason: "done" as const };
      },
    });

    const outcome = await bridge.__test__.runSubagentInPane({
      runId: "fork-guard", index: 0, name: "worker", task: "implement the fix", agent: "worker", cwd,
      context: "fork", parentSessionFile, orchestratorTarget: "target",
      persona: {
        filePath: "worker.md", systemPromptMode: "replace", inheritProjectContext: true,
        inheritSkills: false, systemPrompt: "",
      },
    });

    assert.deepEqual(guardedMessages.map((message) => message.role), ["assistant"]);
    assert.equal(outcome.exitCode, 1);
    assert.match(outcome.errorMessage ?? "", /completed without making edits/);
  });

  it("falls back to the retention launcher when the parent has no resolved credentials", async () => {
    await bridge.__test__.runSubagentInPane({
      runId: "test-run",
      index: 0,
      name: "worker",
      task: "say hello",
      agent: "worker",
      cwd,
      orchestratorTarget: "test-target",
    });

    assert.ok(capturedCommand, "sendLongCommand should have been called with the launch command");
    assert.match(capturedCommand!, /pi-balanced\b/);
    assert.doesNotMatch(capturedCommand!, /credentials\.fifo/);
    assert.doesNotMatch(
      capturedCommand!,
      /(?:^|[\s'"])pi\s+--session/,
      "launch command must not invoke bare `pi` directly",
    );
    const artifactDir = join(agentDir, "agent.balanced", "artifacts", "test-run", "child-0");
    const launchArtifact = readFileSync(join(artifactDir, "launch.sh"), "utf8");
    assert.match(readFileSync(join(artifactDir, "task.md"), "utf8"), /Acceptance level: attested/);
    for (const generated of [capturedCommand!, launchArtifact]) {
      assert.doesNotMatch(generated, /(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY)=/);
      assert.doesNotMatch(generated, /op:\/\//);
    }
  });
});

/**
 * jacek-bridge.ts
 *
 * Intercepts Jacek's pi-subagents `subagent` tool calls and re-dispatches them
 * through pi-interactive-subagents' cmux machinery.
 *
 * Why: Both packages register a tool named "subagent". Projects that pin
 * pi-subagents as a team contract can't install pi-interactive-subagents as a
 * package without a name collision. This bridge lives as a user-scope extension
 * that silently re-routes subagent calls so they spawn in real cmux panes and
 * steer results back when done, without touching any checked-in project files.
 *
 * What is intercepted:
 * - SINGLE calls (task, optional agent). Builtin personas (delegate, scout,
 *   worker, ...) resolve from the pinned pi-subagents package's agents/ dir;
 *   customs from .agents/.pi/agents shadow them.
 * - PARALLEL calls (tasks[]) whose entries stick to agent/task/model/cwd/
 *   count/label. Each child gets its own pane; the bridge itself is the
 *   orchestrator (async, non-blocking) so there is no top-level pane, and one
 *   aggregate result is steered back when all children finish.
 *
 * What falls through to Jacek's native executor:
 * - CHAIN calls (sequential {previous} templating has no pane equivalent).
 * - Calls using semantics the pane launch can't honor: worktree, acceptance,
 *   context: "fork", outputSchema, structured output plumbing, per-task
 *   reads/skill overrides.
 * - Genuinely unknown agent names (let Jacek produce the proper error).
 *
 * Setup (see README § Using alongside pi-subagents):
 *   1. Do NOT install pi-interactive-subagents as a pi package (name conflict).
 *   2. Keep pi-subagents installed at project or user scope.
 *   3. Copy or symlink this file to ~/.pi/agent/extensions/jacek-bridge.ts
 *   4. Set PI_SUBAGENT_MUX=cmux (or tmux/zellij/wezterm) in your shell.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Utilities imported from within this package (relative to pi-extension/).
import {
  isMuxAvailable,
  getMuxBackend,
  muxSetupHint,
  createSurface,
  sendLongCommand,
  pollForExit,
  closeSurface,
  shellEscape,
} from "./subagents/cmux.ts";

import {
  getNewEntries,
  findLastAssistantMessage,
} from "./subagents/session.ts";

import {
  getSubagentActivityFile,
} from "./subagents/activity.ts";

import {
  applyThinkingSuffix,
  findSubagentsRuntimeExtension,
  getAgentDir,
  resolveIntercomSessionTarget,
  resolvePersona,
  resolveSubagentIntercomTarget,
  type ResolvedPersona,
} from "./subagents/persona-resolve.ts";

// When installed via `pi install`, pi puts the package at:
//   ~/.pi/agent/git/github.com/nertzy/pi-interactive-subagents/
// import.meta.url resolves to this file inside that checkout; dirname of it
// is pi-extension/. (Not __dirname: this module runs under "type": "module",
// and pi's own dev docs ban __dirname for package assets.)
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const SUBAGENT_DONE_EXTENSION = join(MODULE_DIR, "subagents", "subagent-done.ts");

// The active preset's agent dir (respects PI_CODING_AGENT_DIR), not a
// hardcoded ~/.pi/agent. A cmux pane starts a fresh login shell that does NOT
// inherit the parent pi's environment, so children must be pinned to this dir
// explicitly (see PI_CODING_AGENT_DIR in the launch env below); otherwise a
// pi launched under a preset (e.g. ~/.pi/agent.anthropic) would silently spawn
// children under the default dir with a different settings.json -- wrong model
// map, wrong defaultModel, missing packages -- so its subagents pick up the
// wrong model.
const AGENT_DIR = getAgentDir();
const DEFAULT_PARALLEL_CONCURRENCY = 4;

// Wall-clock stamp of when this pi session booted (the extension module is
// evaluated once at pi startup). A pane whose cwd was born after this is a
// directory this session created -- the only kind maybeTrustSessionCwd will
// auto-trust.
const SESSION_START_MS = Date.now();

// pi prompts interactively before working in an untrusted folder that carries
// project-local config/skills, which stalls a non-interactive cmux pane at
// launch (the child pi blocks on the prompt and never runs the task). When a
// pane's cwd came into existence during THIS pi session -- e.g. a worktree
// created mid-session -- pre-trust it so the child skips the prompt. Scoped
// tightly on purpose: a dir whose birthtime predates the session is left alone,
// so this never silently trusts a pre-existing folder the user never opted
// into, and an explicit prior decision (true OR false) on the cwd or any nearer
// ancestor is always respected. Writes only AGENT_DIR's trust.json in pi's own
// on-disk shape (canonical-path keys, sorted, trailing newline); the child pane
// is pinned to that preset dir via PI_CODING_AGENT_DIR, so it is the file it
// reads. Atomic temp+rename keeps a concurrent reader from seeing a partial
// file. Takes effect on the next pi start (extensions load once at boot).
function maybeTrustSessionCwd(cwd: string): void {
  let canonical: string;
  let birthMs: number;
  try {
    canonical = realpathSync(cwd);
    birthMs = statSync(canonical).birthtimeMs;
  } catch {
    return; // cwd missing/unreadable -> nothing to do
  }
  // birthtime unavailable (0) or predating the session -> not ours to trust.
  if (!birthMs || birthMs < SESSION_START_MS) return;

  const trustFile = join(AGENT_DIR, "trust.json");
  let data: Record<string, boolean | null> = {};
  if (existsSync(trustFile)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(trustFile, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      data = parsed as Record<string, boolean | null>;
    } catch {
      return; // never clobber a trust store we can't parse
    }
  }

  // Mirror pi's findNearestTrustEntry: the nearest ancestor carrying an
  // explicit true/false decides. Already-true -> no prompt, nothing to do;
  // explicit false nearer than any true -> the user opted out, respect it.
  for (let dir = canonical; ; ) {
    const value = data[dir];
    if (value === true || value === false) return;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  data[canonical] = true;
  const sorted: Record<string, boolean | null> = {};
  for (const key of Object.keys(data).sort()) {
    const v = data[key];
    if (v === true || v === false || v === null) sorted[key] = v;
  }
  try {
    mkdirSync(dirname(trustFile), { recursive: true });
    const tmp = join(AGENT_DIR, `trust.json.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
    renameSync(tmp, trustFile);
    console.error(`[jacek-bridge] auto-trusted session-created cwd for pi: ${canonical}`);
  } catch (err) {
    console.error(`[jacek-bridge] failed to auto-trust cwd ${canonical}:`, err);
  }
}

// Independent SINGLE/PARALLEL dispatches resolve on their own timelines, so
// two children finishing seconds apart would otherwise each fire their own
// triggerTurn:true steer -- stacking separate wake-up turns instead of one.
// Mirrors pi-intercom's own pendingIdleMessages/scheduleInboundFlush pattern
// (index.ts): queue every completed result, debounce briefly, then deliver
// the batch as a single triggered turn (first entry "steer", rest
// "followUp" so they ride the same turn instead of spawning more).
const RESULT_FLUSH_DELAY_MS = 200;
const RESULT_IDLE_RETRY_MS = 500;
// A steer is designed to interrupt a running turn, so deferring until the
// parent goes idle only adds latency -- and a long orchestrator turn can defer
// a batch for minutes. Cap the idle-wait: once a deferred batch has waited this
// long, force-deliver it as a steer even while the parent is busy, trading a
// little batching for a bound on worst-case latency.
const RESULT_MAX_WAIT_MS = 30_000;

interface PendingResult {
  customType: string;
  content: string;
  details: unknown;
}

const pendingResults: PendingResult[] = [];
let resultFlushTimer: NodeJS.Timeout | null = null;
// Wall-clock stamp of when the current batch first found the parent busy; null
// when nothing is deferred. Drives the RESULT_MAX_WAIT_MS force-deliver.
let firstDeferredAt: number | null = null;

type OrphanSink = (batch: PendingResult[]) => void;

// A torn-down context can't be steered into, but completed results must not
// vanish silently -- write them somewhere the user can recover them.
function defaultOrphanSink(batch: PendingResult[]): void {
  try {
    const path = join(tmpdir(), `jacek-bridge-orphaned-results-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify(batch, null, 2));
    console.error(
      `[jacek-bridge] context torn down; ${batch.length} subagent result(s) persisted to ${path}`,
    );
  } catch (err) {
    console.error(
      `[jacek-bridge] context torn down; failed to persist ${batch.length} orphaned subagent result(s):`,
      err,
    );
  }
}

let orphanSink: OrphanSink = defaultOrphanSink;

function scheduleResultFlush(pi: ExtensionAPI, ctx: ExtensionContext, delayMs = RESULT_FLUSH_DELAY_MS): void {
  if (resultFlushTimer) clearTimeout(resultFlushTimer);
  resultFlushTimer = setTimeout(() => {
    resultFlushTimer = null;
    flushPendingResults(pi, ctx);
  }, delayMs);
}

function emitPendingBatch(pi: ExtensionAPI): void {
  const batch = pendingResults.splice(0, pendingResults.length);
  firstDeferredAt = null;
  batch.forEach((entry, i) => {
    pi.sendMessage(
      { customType: entry.customType, content: entry.content, display: true, details: entry.details },
      i === 0 ? { triggerTurn: true, deliverAs: "steer" } : { deliverAs: "followUp" },
    );
  });
}

function flushPendingResults(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (pendingResults.length === 0) return;

  let idle: boolean;
  try {
    idle = ctx.isIdle();
  } catch {
    // Stale/torn-down context (session reloaded or exited). We can't steer
    // through a dead context, so hand the batch to the orphan sink rather than
    // dropping it silently.
    const batch = pendingResults.splice(0, pendingResults.length);
    firstDeferredAt = null;
    orphanSink(batch);
    return;
  }

  if (idle) {
    emitPendingBatch(pi);
    return;
  }

  // Parent is busy. Bound how long we defer: reschedule until RESULT_MAX_WAIT_MS
  // has elapsed since the batch first deferred, then force-deliver the steer
  // regardless of idle state.
  const now = Date.now();
  if (firstDeferredAt === null) firstDeferredAt = now;
  if (now - firstDeferredAt >= RESULT_MAX_WAIT_MS) {
    emitPendingBatch(pi);
    return;
  }
  scheduleResultFlush(pi, ctx, RESULT_IDLE_RETRY_MS);
}

function deliverResult(pi: ExtensionAPI, ctx: ExtensionContext, entry: PendingResult): void {
  pendingResults.push(entry);
  scheduleResultFlush(pi, ctx);
}

// Test-only surface (mirrors the __test__ convention in subagents/index.ts).
// Module-level pendingResults/resultFlushTimer/firstDeferredAt are process-wide
// singletons; tests must reset between cases via resetForTest().
export const __test__ = {
  deliverResult,
  setOrphanSink(sink: OrphanSink): void {
    orphanSink = sink;
  },
  resetForTest(): void {
    if (resultFlushTimer) {
      clearTimeout(resultFlushTimer);
      resultFlushTimer = null;
    }
    pendingResults.length = 0;
    firstDeferredAt = null;
    orphanSink = defaultOrphanSink;
  },
};

interface SubagentParams {
  name?: string;
  task?: string;
  tasks?: unknown[];
  chain?: unknown[];
  agent?: string;
  model?: string;
  skills?: string;
  tools?: string;
  cwd?: string;
  systemPrompt?: string;
  concurrency?: number;
  worktree?: boolean;
  context?: string;
  acceptance?: unknown;
}

interface ParallelTaskEntry {
  agent?: string;
  task?: string;
  model?: string;
  cwd?: string;
  count?: number;
  label?: string;
}

// Per-entry keys the pane launch can honor. Anything else (outputSchema,
// acceptance, reads, skill, output, ...) changes semantics we can't
// reproduce, so its presence falls the whole call through to Jacek.
const SUPPORTED_PARALLEL_TASK_KEYS = new Set([
  "agent",
  "task",
  "model",
  "cwd",
  "count",
  "label",
  "phase",
]);

interface ChildSpec {
  runId: string;
  index: number;
  name: string;
  task: string;
  agent?: string;
  model?: string;
  cwd: string;
  persona?: ResolvedPersona;
  orchestratorTarget: string;
}

interface ChildOutcome {
  name: string;
  agent?: string;
  index: number;
  exitCode: number | null;
  elapsedText: string;
  summary: string;
  sessionFile: string;
  errorMessage?: string;
}

export default function (pi: ExtensionAPI) {
  // One-time startup signal: this extension only loads when pi starts, so a
  // session already running when PI_SUBAGENT_MUX is set or the mux terminal
  // changes underneath it will silently keep using whatever was true at
  // load time, with no other visible sign why panes aren't appearing.
  const activeBackend = getMuxBackend();
  if (activeBackend) {
    console.error(`[jacek-bridge] active: routing subagent calls to ${activeBackend} panes.`);
  } else {
    console.error(`[jacek-bridge] inactive (${muxSetupHint()}); subagent calls fall through to Jacek's native executor.`);
  }

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "subagent") return;

    const params = event.input as SubagentParams;

    // Chain mode stays with Jacek's implementation (sequential dependencies).
    if (params.chain) return;
    // Semantics a pane launch can't honor.
    if (params.worktree || params.acceptance || params.context === "fork") return;

    // Require cmux to be available; fall through to Jacek if not.
    if (!isMuxAvailable()) return;

    const runId = Math.random().toString(16).slice(2, 10);
    const orchestratorTarget = resolveIntercomSessionTarget(
      pi.getSessionName(),
      ctx.sessionManager.getSessionId(),
    );

    // ---- PARALLEL mode ----
    if (params.tasks) {
      const specs = buildParallelSpecs(params, runId, orchestratorTarget);
      if (!specs) return; // unsupported shape or unknown persona -> Jacek

      const concurrency = Math.max(
        1,
        Math.floor(params.concurrency ?? DEFAULT_PARALLEL_CONCURRENCY),
      );
      void dispatchParallel(pi, ctx, specs, concurrency);
      return {
        block: true,
        reason: `Rerouted ${specs.length} parallel subagent(s) to cmux panes (jacek-bridge). Aggregate result will be delivered as a steer message.`,
      };
    }

    // ---- SINGLE mode ----
    if (!params.task) return;

    const cwd = params.cwd ?? process.cwd();

    // Resolve the persona for model/tools/skills/systemPrompt fidelity.
    // Builtins now resolve from the pi-subagents package's agents/ dir;
    // only a genuinely unknown agent name falls through to Jacek so it can
    // produce the proper error.
    const persona = params.agent ? resolvePersona(params.agent, cwd) : undefined;
    if (params.agent && !persona) return;

    const spec: ChildSpec = {
      runId,
      index: 0,
      name: params.name ?? params.agent ?? "subagent",
      task: params.task,
      agent: params.agent,
      model: params.model,
      cwd,
      persona,
      orchestratorTarget,
    };

    void dispatchSingle(pi, ctx, spec);
    return {
      block: true,
      reason: `Rerouted to cmux pane (jacek-bridge). Result will be delivered as a steer message.`,
    };
  });
}

// Validates the tasks[] payload and expands count. Returns undefined when
// anything about the call means Jacek should run it natively instead.
function buildParallelSpecs(
  params: SubagentParams,
  runId: string,
  orchestratorTarget: string,
): ChildSpec[] | undefined {
  if (!Array.isArray(params.tasks) || params.tasks.length === 0) return undefined;

  const specs: ChildSpec[] = [];
  for (const raw of params.tasks) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (entry[key] !== undefined && !SUPPORTED_PARALLEL_TASK_KEYS.has(key)) return undefined;
    }

    const task = entry as ParallelTaskEntry;
    if (typeof task.agent !== "string" || !task.agent) return undefined;
    if (typeof task.task !== "string" || !task.task) return undefined;

    const cwd = task.cwd ?? params.cwd ?? process.cwd();
    const persona = resolvePersona(task.agent, cwd);
    if (!persona) return undefined; // unknown agent -> let Jacek error properly

    const count = Math.max(1, Math.floor(task.count ?? 1));
    for (let i = 0; i < count; i++) {
      specs.push({
        runId,
        index: specs.length,
        name: task.label ?? task.agent,
        task: task.task,
        agent: task.agent,
        model: task.model,
        cwd,
        persona,
        orchestratorTarget,
      });
    }
  }
  return specs;
}

async function dispatchSingle(pi: ExtensionAPI, ctx: ExtensionContext, spec: ChildSpec): Promise<void> {
  const outcome = await runSubagentInPane(spec);
  const content = outcome.errorMessage
    ? `Sub-agent "${outcome.name}" failed (auto-retry exhausted).\n\nError: ${outcome.errorMessage}`
    : outcome.exitCode !== 0
    ? `Sub-agent "${outcome.name}" failed (exit ${outcome.exitCode}, ${outcome.elapsedText}).\n\n${outcome.summary}`
    : `Sub-agent "${outcome.name}" completed (${outcome.elapsedText}).\n\n${outcome.summary}`;

  deliverResult(pi, ctx, {
    customType: "subagent_result",
    content,
    details: {
      name: outcome.name,
      task: spec.task,
      agent: spec.agent,
      exitCode: outcome.exitCode,
      sessionFile: outcome.sessionFile,
      error: outcome.errorMessage,
    },
  });
}

async function dispatchParallel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  specs: ChildSpec[],
  concurrency: number,
): Promise<void> {
  const startTime = Date.now();
  const outcomes = await runPool(
    specs.map((spec) => () => runSubagentInPane(spec)),
    concurrency,
  );

  const failed = outcomes.filter((o) => o.errorMessage || o.exitCode !== 0);
  const header = failed.length === 0
    ? `Parallel subagents completed (${outcomes.length} children, ${formatElapsed(startTime)}).`
    : `Parallel subagents finished with ${failed.length}/${outcomes.length} failure(s) (${formatElapsed(startTime)}).`;

  const sections = outcomes.map((o) => {
    const status = o.errorMessage
      ? `error: ${o.errorMessage}`
      : o.exitCode !== 0
      ? `failed (exit ${o.exitCode}, ${o.elapsedText})`
      : `completed (${o.elapsedText})`;
    return `${o.index + 1}. ${o.name} - ${status}\n${o.summary}`;
  });

  deliverResult(pi, ctx, {
    customType: "subagent_result",
    content: `${header}\n\n${sections.join("\n\n")}`,
    details: {
      mode: "parallel",
      runId: specs[0]?.runId,
      children: outcomes.map((o) => ({
        name: o.name,
        agent: o.agent,
        index: o.index,
        exitCode: o.exitCode,
        sessionFile: o.sessionFile,
        error: o.errorMessage,
      })),
    },
  });
}

async function runPool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}

function formatElapsed(startTime: number): string {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

// Core pane dispatch. Never throws; failures come back in the outcome.
async function runSubagentInPane(spec: ChildSpec): Promise<ChildOutcome> {
  const { runId, index, name, task, cwd, persona } = spec;

  // Skip pi's trust prompt for a worktree this session created (see helper).
  // Synchronous and runs before any await, so parallel pool workers can't
  // interleave the trust.json read-modify-write.
  maybeTrustSessionCwd(cwd);

  const childId = `${runId}-${index}`;
  const startTime = Date.now();

  // Session file
  const sessionDir = join(AGENT_DIR, "sessions", "--jacek-bridge--");
  mkdirSync(sessionDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const sessionFile = join(sessionDir, `${timestamp}_${childId}.jsonl`);

  // Activity file (HazAT status tracking)
  const artifactDir = join(AGENT_DIR, "artifacts", runId, `child-${index}`);
  const activityFile = getSubagentActivityFile(artifactDir, childId);
  mkdirSync(dirname(activityFile), { recursive: true });

  // Write task to an artifact file (avoids shell-escaping multiline strings)
  const modeHint = "Complete your task autonomously.";
  const summaryInstruction = "Your FINAL assistant message should summarize what you accomplished.";
  const fullTask = `${modeHint}\n\n${task}\n\n${summaryInstruction}`;
  const taskArtifact = join(artifactDir, "task.md");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(taskArtifact, fullTask, "utf8");

  // Create cmux pane
  const surface = createSurface(name);
  // Let the shell start up before sending the command
  await new Promise<void>((resolve) => setTimeout(resolve, 500));

  // Build pi launch command
  const parts: string[] = ["pi"];
  parts.push("--session", shellEscape(sessionFile));
  // Load HazAT's subagent-done extension so the child can call subagent_done
  parts.push("-e", shellEscape(SUBAGENT_DONE_EXTENSION));

  // Additively load pi-subagents' own prompt-runtime extension when we can
  // find it, so inheritProjectContext/inheritSkills are honored the same way
  // native (non-cmux) children get them. Best-effort: fails open (child sees
  // full inherited context) rather than blocking cmux dispatch entirely.
  const runtimeExtPath = persona ? findSubagentsRuntimeExtension(cwd) : undefined;
  if (runtimeExtPath) parts.push("-e", shellEscape(runtimeExtPath));

  const resolvedModel = spec.model ?? persona?.model;
  const modelArg = applyThinkingSuffix(resolvedModel, persona?.thinking);
  if (modelArg) parts.push("--model", shellEscape(modelArg));

  if (persona && !persona.inheritSkills) parts.push("--no-skills");
  if (persona?.tools?.length) parts.push("--tools", shellEscape(persona.tools.join(",")));

  let systemPromptTempDir: string | undefined;
  if (persona?.systemPrompt) {
    systemPromptTempDir = mkdtempSync(join(tmpdir(), "jacek-bridge-"));
    const promptPath = join(systemPromptTempDir, "system-prompt.md");
    writeFileSync(promptPath, persona.systemPrompt, "utf8");
    parts.push(persona.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", shellEscape(promptPath));
  }

  // Task delivered via @file
  parts.push(shellEscape(`@${taskArtifact}`));

  const agentLabel = spec.agent ?? name;
  const intercomSessionName = resolveSubagentIntercomTarget(runId, agentLabel, index);

  const envParts = [
    `PI_SUBAGENT_NAME=${shellEscape(name)}`,
    `PI_SUBAGENT_ID=${shellEscape(childId)}`,
    `PI_SUBAGENT_SESSION=${shellEscape(sessionFile)}`,
    `PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`,
    `PI_SUBAGENT_SURFACE=${shellEscape(surface)}`,
    `PI_SUBAGENT_AUTO_EXIT=1`,
    // Same env contract Jacek's native children get (src/runs/shared/pi-args.ts
    // + subagent-prompt-runtime.ts) -- this is what activates pi-intercom's
    // contact_supervisor tool with no extra wiring, since pi-intercom is a
    // user-scope package that auto-loads for any `pi` invocation.
    `PI_SUBAGENT_ORCHESTRATOR_TARGET=${shellEscape(spec.orchestratorTarget)}`,
    `PI_SUBAGENT_RUN_ID=${shellEscape(runId)}`,
    `PI_SUBAGENT_CHILD_AGENT=${shellEscape(agentLabel)}`,
    `PI_SUBAGENT_CHILD_INDEX=${index}`,
    `PI_SUBAGENT_INTERCOM_SESSION_NAME=${shellEscape(intercomSessionName)}`,
    // Pin the child to the parent's preset dir. Auth is shared (each preset's
    // auth.json is the same file/symlink), so this needs no secret on disk --
    // it just selects the right settings.json (model map, defaultModel,
    // packages) so the child resolves the same model the parent would.
    `PI_CODING_AGENT_DIR=${shellEscape(AGENT_DIR)}`,
  ];
  if (spec.agent) envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(spec.agent)}`);
  if (persona && runtimeExtPath) {
    envParts.push(`PI_SUBAGENT_INHERIT_PROJECT_CONTEXT=${persona.inheritProjectContext ? "1" : "0"}`);
    envParts.push(`PI_SUBAGENT_INHERIT_SKILLS=${persona.inheritSkills ? "1" : "0"}`);
  }

  const cdPrefix = `cd ${shellEscape(cwd)} && `;
  // Strip Ghostty terminal identity from the child so pi-quiver's session-name
  // extension skips its OSC-2 tab rename. Under a Ghostty-backed cmux that raw
  // OSC-2 title bleeds into the shared workspace pill, so a subagent setting its
  // (intercom) session name clobbers the parent session's workspace name. With
  // these vars gone isGhosttyActive() is false and the rename no-ops; the child
  // keeps its session name for intercom and workspace/tab naming stays the
  // parent's alone.
  const stripGhosttyIdent =
    "env -u TERM_PROGRAM -u GHOSTTY_RESOURCES_DIR -u GHOSTTY_BIN_DIR ";
  const command = `${cdPrefix}${envParts.join(" ")} ${stripGhosttyIdent}${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;

  const launchScript = join(artifactDir, "launch.sh");

  const abort = new AbortController();
  try {
    sendLongCommand(surface, command, {
      scriptPath: launchScript,
      scriptPreamble: [
        `# subagent-cmux-bridge: ${name}`,
        `# Session: ${sessionFile}`,
        `# Surface: ${surface}`,
      ].join("\n"),
    });

    const result = await pollForExit(surface, abort.signal, {
      interval: 1000,
      sessionFile,
    });

    let summary = "Sub-agent exited without output";
    if (existsSync(sessionFile)) {
      try {
        const entries = getNewEntries(sessionFile, 0);
        summary = findLastAssistantMessage(entries) ?? summary;
      } catch {}
    }

    closeSurface(surface);
    if (systemPromptTempDir) rmSync(systemPromptTempDir, { recursive: true, force: true });

    return {
      name,
      agent: spec.agent,
      index,
      exitCode: result.exitCode,
      elapsedText: formatElapsed(startTime),
      summary,
      sessionFile,
      errorMessage: result.errorMessage,
    };
  } catch (err: unknown) {
    try { closeSurface(surface); } catch {}
    if (systemPromptTempDir) { try { rmSync(systemPromptTempDir, { recursive: true, force: true }); } catch {} }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name,
      agent: spec.agent,
      index,
      exitCode: null,
      elapsedText: formatElapsed(startTime),
      summary: "Sub-agent errored before producing output",
      sessionFile,
      errorMessage: msg,
    };
  }
}

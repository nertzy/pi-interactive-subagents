/**
 * cohort-bridge.ts
 *
 * Intercepts pi-cohort's (Jacek's subagent-dispatch package, formerly
 * pi-subagents) `subagent` tool calls and re-dispatches them through
 * pi-interactive-subagents' cmux machinery.
 *
 * Why: Both packages register a tool named "subagent". Projects that pin
 * pi-cohort as a team contract can't install pi-interactive-subagents as a
 * package without a name collision. This bridge lives as a user-scope extension
 * that silently re-routes subagent calls so they spawn in real cmux panes and
 * steer results back when done, without touching any checked-in project files.
 *
 * What is intercepted:
 * - SINGLE calls (task, optional agent). Builtin personas (delegate, scout,
 *   worker, ...) resolve from the pinned pi-cohort package's agents/ dir;
 *   customs from .agents/.pi/agents shadow them.
 * - PARALLEL calls (tasks[]) whose entries use pane-supported child fields.
 *   Each child gets its own pane; the bridge itself is
 *   the orchestrator (async, non-blocking) so there is no top-level pane, and
 *   one aggregate result is steered back when all children finish.
 * - Sequential chains, static parallel groups, and dynamic fanout groups,
 *   with pi-cohort's template/named-output contract and one pane per child.
 * - `clarify: true` calls, using pi-cohort's parent TUI before pane dispatch.
 * - `output` (string path or false), including outputMode inline/file-only:
 *   the child is instructed to write the file; if it doesn't, its final
 *   summary is persisted there, mirroring pi-cohort's contract (see
 *   subagents/output.ts for the one deliberate deviation).
 *
 * Native fallback is limited to unavailable muxes, management actions, and
 * genuinely future orchestration fields that this bridge does not recognize.
 * Invalid current request semantics are blocked before any backend launches.
 *
 * Setup (see README § Using alongside pi-cohort):
 *   1. Do NOT install pi-interactive-subagents as a pi package (name conflict).
 *   2. Keep pi-cohort installed at project or user scope.
 *   3. Copy or symlink this file to ~/.pi/agent/extensions/cohort-bridge.ts
 *   4. Set PI_SUBAGENT_MUX=cmux (or tmux/zellij/wezterm) in your shell.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
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
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Utilities imported from within this package (relative to pi-extension/).
import {
  isMuxAvailable,
  getMuxBackend,
  muxPreference,
  muxSetupHint,
  createSurface,
  sendLongCommand,
  pollForExit,
  closeSurface,
  readScreen,
  shellEscape,
} from "./subagents/cmux.ts";

import {
  getNewEntries,
  findLastAssistantMessage,
  seedSubagentSessionFile,
} from "./subagents/session.ts";
import {
  isPermanentModelOrAuthFailure,
  redactCredentialValues,
} from "./subagents/model-failure.ts";

import {
  getSubagentActivityFile,
  readSubagentActivityFile,
} from "./subagents/activity.ts";

import {
  injectOutputInstruction,
  resolveOutputPath,
  resolveOutputAfterRun,
  snapshotOutput,
} from "./subagents/output.ts";

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
    console.error(`[cohort-bridge] auto-trusted session-created cwd for pi: ${canonical}`);
  } catch (err) {
    console.error(`[cohort-bridge] failed to auto-trust cwd ${canonical}:`, err);
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
    const path = join(tmpdir(), `cohort-bridge-orphaned-results-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify(batch, null, 2));
    console.error(
      `[cohort-bridge] context torn down; ${batch.length} subagent result(s) persisted to ${path}`,
    );
  } catch (err) {
    console.error(
      `[cohort-bridge] context torn down; failed to persist ${batch.length} orphaned subagent result(s):`,
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
  buildStatusAugmentation,
  // Exposes the actual production launch path (not just buildPaneLaunchCommand
  // in isolation) so a test can catch a regression where script generation
  // stops routing through the helper -- see cohort-bridge-pane-launch.test.ts.
  runSubagentInPane,
  dispatchSingle,
  trackLiveChild(child: LiveChild): void {
    liveChildren.set(child.childId, child);
  },
  setPaneLifecycleHooks(hooks: Partial<typeof paneLifecycleHooks>): void {
    Object.assign(paneLifecycleHooks, hooks);
  },
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
    liveChildren.clear();
    Object.assign(paneLifecycleHooks, defaultPaneLifecycleHooks);
  },
};

interface SubagentParams {
  name?: string;
  task?: string;
  tasks?: unknown[];
  chain?: unknown[];
  agent?: string;
  model?: string;
  skills?: string | string[] | false;
  tools?: string;
  cwd?: string;
  systemPrompt?: string;
  concurrency?: number;
  worktree?: boolean;
  context?: string;
  acceptance?: unknown;
  output?: string | boolean;
  outputMode?: string;
  outputSchema?: unknown;
  skill?: string | string[] | false;
  reads?: string[] | false;
  progress?: boolean | string;
  clarify?: boolean;
  async?: boolean;
  chainDir?: string;
}

interface ParallelTaskEntry {
  agent?: string;
  task?: string;
  model?: string;
  cwd?: string;
  count?: number;
  label?: string;
  phase?: string;
  as?: string;
  output?: string | boolean;
  outputMode?: string;
  context?: string;
  acceptance?: unknown;
  skill?: string | string[] | false;
  reads?: string[] | false;
  progress?: boolean | string;
  outputSchema?: unknown;
  parentSessionFile?: string;
}

export type PaneChainTask = ParallelTaskEntry & { agent: string; task?: string };
export interface PaneDynamicChainStep {
  expand: {
    from: { output: string; path: string };
    item?: string;
    key?: string;
    maxItems?: number;
    onEmpty?: "skip" | "fail";
  };
  parallel: PaneChainTask;
  collect: { as: string; outputSchema?: unknown };
  concurrency?: number;
  failFast?: boolean;
  phase?: string;
  label?: string;
  acceptance?: unknown;
}
export type PaneChainStep = PaneChainTask | PaneDynamicChainStep | {
  parallel: PaneChainTask[];
  concurrency?: number;
  failFast?: boolean;
  cwd?: string;
  worktree?: boolean;
};

export interface PaneClarifyResult {
  confirmed: boolean;
  templates: string[];
  behaviorOverrides: Array<{
    output?: string | false;
    reads?: string[] | false;
    progress?: boolean;
    model?: string;
    skills?: string[] | false;
  } | undefined>;
  runInBackground?: boolean;
}

const SUPPORTED_PARALLEL_TASK_KEYS = new Set([
  "agent", "task", "model", "cwd", "count", "label", "phase", "as", "output", "outputMode",
  "context", "acceptance", "skill", "reads", "progress", "outputSchema",
]);

const OUTPUT_REFERENCE = /\{outputs\.([^}]*)\}/g;
const SAFE_OUTPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isStaticParallelChainStep(step: PaneChainStep): step is Extract<PaneChainStep, { parallel: PaneChainTask[] }> {
  return Boolean(step) && typeof step === "object" && "parallel" in step && Array.isArray(step.parallel);
}

function isDynamicPaneChainStep(step: PaneChainStep): step is PaneDynamicChainStep {
  return Boolean(step) && typeof step === "object" && "expand" in step && "collect" in step && "parallel" in step && !Array.isArray(step.parallel);
}

function chainTasks(step: PaneChainStep): PaneChainTask[] {
  return isStaticParallelChainStep(step) ? step.parallel : isDynamicPaneChainStep(step) ? [step.parallel] : [step];
}

function expandPaneChainCounts(chain: PaneChainStep[]): PaneChainStep[] {
  return chain.map((step, stepIndex) => {
    if (!isStaticParallelChainStep(step)) return step;
    const parallel = step.parallel.flatMap((task, taskIndex) => {
      const count = task.count ?? 1;
      if (!Number.isInteger(count) || count < 1) throw new Error(`chain[${stepIndex}].parallel[${taskIndex}].count must be an integer >= 1`);
      const { count: _count, ...concrete } = task;
      return Array.from({ length: count }, () => ({ ...concrete }));
    });
    return { ...step, parallel };
  });
}

/** Validate the complete chain before any artifacts or panes are created. */
export function validatePaneChain(chain: PaneChainStep[], dynamicFanoutMaxItems?: number): void {
  if (!Array.isArray(chain) || chain.length === 0) throw new Error("chain must be a non-empty array");
  const available = new Set<string>();
  const seen = new Set<string>();
  chain.forEach((step, stepIndex) => {
    if (!step || typeof step !== "object") throw new Error(`Chain step ${stepIndex + 1} must be an object.`);
    const dynamic = isDynamicPaneChainStep(step);
    if (("expand" in step || "collect" in step) && !dynamic) {
      throw new Error(`Dynamic chain step ${stepIndex + 1} requires expand, a single parallel template object, and collect; dynamic expand/collect cannot be mixed with static parallel arrays.`);
    }
    if (dynamic) {
      const prefix = `Dynamic chain step ${stepIndex + 1}`;
      if (!step.expand?.from) throw new Error(`${prefix} requires expand.from.`);
      if (!SAFE_OUTPUT_NAME.test(step.expand.from.output)) throw new Error(`${prefix} has invalid expand.from.output '${step.expand.from.output}'.`);
      if (!available.has(step.expand.from.output)) throw new Error(`${prefix} references unknown output '${step.expand.from.output}'. Named outputs are only available after producing step/group completes.`);
      if (typeof step.expand.from.path !== "string") throw new Error(`${prefix} expand.from.path must be a JSON Pointer.`);
      if (step.expand.maxItems === undefined && dynamicFanoutMaxItems === undefined) throw new Error(`${prefix} requires expand.maxItems or config.chain.dynamicFanout.maxItems.`);
      if (step.expand.maxItems !== undefined && (!Number.isInteger(step.expand.maxItems) || step.expand.maxItems < 0)) throw new Error(`${prefix} expand.maxItems must be an integer >= 0.`);
      if (step.expand.onEmpty !== undefined && step.expand.onEmpty !== "skip" && step.expand.onEmpty !== "fail") throw new Error(`${prefix} expand.onEmpty must be 'skip' or 'fail'.`);
      if (!step.collect?.as || !SAFE_OUTPUT_NAME.test(step.collect.as)) throw new Error(`${prefix} requires collect.as with a safe output name.`);
    }
    const tasks = chainTasks(step);
    if (isStaticParallelChainStep(step) && tasks.length === 0) throw new Error(`Chain step ${stepIndex + 1} requires a non-empty parallel array.`);
    tasks.forEach((task, taskIndex) => {
      const prefix = isStaticParallelChainStep(step) ? `Chain step ${stepIndex + 1} task ${taskIndex + 1}` : `Chain step ${stepIndex + 1}`;
      if (!task || typeof task.agent !== "string" || !task.agent) throw new Error(`${prefix} requires agent.`);
      const template = task.task ?? (stepIndex === 0 ? undefined : "{previous}");
      if (template === undefined) throw new Error(`${prefix} requires task because there is no previous output.`);
      if (typeof template !== "string") throw new Error(`${prefix} task must be a string.`);
      if (task.output === true) throw new Error(`${prefix} output must be a concrete path or false.`);
      if (task.outputMode !== undefined && task.outputMode !== "inline" && task.outputMode !== "file-only") throw new Error(`${prefix} has invalid outputMode.`);
      if (task.outputMode === "file-only" && typeof task.output !== "string") throw new Error(`${prefix} file-only outputMode requires an output path.`);
      for (const match of template.matchAll(OUTPUT_REFERENCE)) {
        const name = match[1]!;
        if (!SAFE_OUTPUT_NAME.test(name) || !available.has(name)) {
          throw new Error(`Unknown chain output reference '${match[0]}' at step ${stepIndex + 1}. Named outputs are only available after producing step/group completes.`);
        }
      }
      const outputName = dynamic ? step.collect.as : task.as;
      if (outputName) {
        if (!SAFE_OUTPUT_NAME.test(outputName)) throw new Error(`Invalid chain output name '${outputName}' at step ${stepIndex + 1}.`);
        if (seen.has(outputName)) throw new Error(`Duplicate chain output name '${outputName}'.`);
        seen.add(outputName);
      }
    });
    if (dynamic) available.add(step.collect.as);
    else for (const task of tasks) if (task.as) available.add(task.as);
  });
}

function resolveChainTemplate(template: string, originalTask: string, previous: string, chainDir: string, outputs: Record<string, { text: string }>): string {
  return template
    .replace(/\{task\}/g, originalTask)
    .replace(/\{previous\}/g, previous)
    .replace(/\{chain_dir\}/g, chainDir)
    .replace(OUTPUT_REFERENCE, (raw, name: string) => outputs[name]?.text ?? raw);
}

function chainOutcomeText(outcome: ChildOutcome): string {
  return outcome.structuredOutput !== undefined ? JSON.stringify(outcome.structuredOutput) : outcome.summary;
}

function aggregateChainParallel(outcomes: ChildOutcome[]): string {
  return outcomes.map((outcome, index) => {
    const status = outcome.errorMessage
      ? `WARNING: ${outcome.errorMessage}\n`
      : outcome.exitCode !== 0 ? `FAILED (exit code ${outcome.exitCode})\n` : "";
    return `=== Parallel Task ${index + 1} (${outcome.agent ?? outcome.name}) ===\n${status}${chainOutcomeText(outcome)}`;
  }).join("\n\n");
}

export async function executePaneChain(
  chain: PaneChainStep[],
  options: {
    originalTask: string;
    cwd: string;
    chainDir: string;
    run: (spec: ChildSpec) => Promise<ChildOutcome>;
    baseSpec?: Partial<ChildSpec>;
    personaResolver?: (agent: string, cwd: string) => ResolvedPersona | undefined;
    runWorktreeGroup?: (
      specs: ChildSpec[],
      run: (specs: ChildSpec[]) => Promise<ChildOutcome[]>,
      cwd: string,
    ) => Promise<ChildOutcome[]>;
    evaluateGroupAcceptance?: (
      acceptance: unknown,
      outcomes: ChildOutcome[],
      notes: string,
      agent: string,
      task: string,
    ) => Promise<string | undefined>;
  },
): Promise<{
  steps: ChildOutcome[];
  previous: string;
  outputs: Record<string, { text: string; structured?: unknown; agent?: string; stepIndex: number }>;
  failedStep?: number;
}> {
  chain = expandPaneChainCounts(chain);
  const dynamicRuntime = chain.some(isDynamicPaneChainStep) ? await loadCohortRuntime(options.cwd) : undefined;
  validatePaneChain(chain, dynamicRuntime?.dynamicFanoutMaxItems);
  dynamicRuntime?.validateChainOutputBindings(chain, { maxItems: dynamicRuntime.dynamicFanoutMaxItems });
  if (options.personaResolver) {
    chain.forEach((step) => chainTasks(step).forEach((task) => {
      const cwd = resolve(options.cwd, task.cwd ?? (isStaticParallelChainStep(step) ? step.cwd ?? "." : "."));
      if (!options.personaResolver!(task.agent, cwd)) throw new Error(`Unknown agent: ${task.agent}`);
    }));
  }
  const steps: ChildOutcome[] = [];
  const outputs: Record<string, { text: string; structured?: unknown; agent?: string; stepIndex: number }> = {};
  let previous = "";
  let flatIndex = 0;
  for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
    const step = chain[stepIndex]!;
    const dynamic = isDynamicPaneChainStep(step);
    const materialized = dynamic
      ? dynamicRuntime!.dynamic.materializeDynamicParallelStep(step, outputs, stepIndex, { maxItems: dynamicRuntime!.dynamicFanoutMaxItems })
      : undefined;
    if (dynamic && materialized!.parallel.length === 0) {
      const collection = materialized!.collectedOnEmpty ?? [];
      dynamicRuntime!.dynamic.validateDynamicCollection(step.collect.outputSchema, collection);
      outputs[step.collect.as] = {
        text: JSON.stringify(collection), structured: collection,
        agent: step.parallel.agent, stepIndex,
      };
      previous = "Dynamic fanout produced 0 results.";
      if (step.acceptance !== undefined && options.evaluateGroupAcceptance) {
        const failure = await options.evaluateGroupAcceptance(
          step.acceptance, [], previous, step.parallel.agent,
          step.parallel.task ?? options.originalTask,
        );
        if (failure) return { steps, previous: `${previous}\n\n${failure}`, outputs, failedStep: stepIndex };
      }
      continue;
    }
    const tasks = materialized?.parallel ?? chainTasks(step);
    const specs = tasks.map((task, taskIndex): ChildSpec => {
      const cwd = resolve(options.cwd, task.cwd ?? (isStaticParallelChainStep(step) ? step.cwd ?? "." : "."));
      const output = normalizeOutput(task.output, task.outputMode, options.chainDir);
      if (!output) throw new Error(`Chain step ${stepIndex + 1} task ${taskIndex + 1} has invalid output settings.`);
      const persona = options.personaResolver?.(task.agent, cwd) ?? options.baseSpec?.persona;
      if (options.personaResolver && !persona) throw new Error(`Unknown agent: ${task.agent}`);
      if (persona?.disabled) throw new Error(`Agent '${task.agent}' is disabled.`);
      return {
        runId: options.baseSpec?.runId ?? "chain",
        index: flatIndex + taskIndex,
        ...(materialized?.items[taskIndex]?.idKey ? { idKey: materialized.items[taskIndex]!.idKey } : {}),
        name: task.label ?? task.agent,
        task: resolveChainTemplate(task.task ?? "{previous}", options.originalTask, previous, options.chainDir, outputs),
        agent: task.agent,
        model: task.model,
        cwd,
        persona,
        orchestratorTarget: options.baseSpec?.orchestratorTarget ?? "",
        outputPath: output.outputPath,
        ...(typeof task.output === "string" && !isAbsolute(task.output) ? { outputRelativePath: task.output } : {}),
        outputMode: output.outputMode,
        context: options.baseSpec?.context,
        skills: resolveChainSkills(persona?.skills ?? [], options.baseSpec?.skills ?? [], task.skill),
        acceptance: task.acceptance,
        acceptanceContext: { mode: "chain", async: true, ...(dynamic ? { dynamic: true } : {}) },
        reads: task.reads,
        progress: task.progress,
        outputSchema: task.outputSchema,
        parentSessionFile: options.baseSpec?.parentSessionFile,
      };
    });
    const parallel = isStaticParallelChainStep(step) || dynamic;
    if (parallel && !(isStaticParallelChainStep(step) && step.worktree)) assertDistinctOutputPaths(specs);
    const concurrency = "concurrency" in step ? step.concurrency : undefined;
    const failFast = "failFast" in step ? step.failFast : undefined;
    const runParallel = (groupSpecs: ChildSpec[]) => runPool(
      groupSpecs.map((spec) => () => options.run(spec)),
      Math.max(1, Math.floor(concurrency ?? groupSpecs.length)),
      failFast ? (outcome) => childOutcomeFailed(outcome as ChildOutcome) : undefined,
    );
    const outcomes = parallel
      ? isStaticParallelChainStep(step) && step.worktree && options.runWorktreeGroup
        ? await options.runWorktreeGroup(specs, runParallel, specs[0]!.cwd)
        : await runParallel(specs)
      : [await options.run(specs[0]!)];
    steps.push(...outcomes);
    flatIndex += specs.length;
    previous = parallel ? aggregateChainParallel(outcomes) : chainOutcomeText(outcomes[0]!);
    if (dynamic && step.acceptance !== undefined && options.evaluateGroupAcceptance && !outcomes.some(childOutcomeFailed)) {
      const failure = await options.evaluateGroupAcceptance(
        step.acceptance, outcomes,
        `Dynamic fanout collected ${outcomes.length} result(s) into ${step.collect.as}.`,
        step.parallel.agent, step.parallel.task ?? options.originalTask,
      );
      if (failure) return { steps, previous: `${previous}\n\n${failure}`, outputs, failedStep: stepIndex };
    }
    if (outcomes.some(childOutcomeFailed)) {
      return { steps, previous, outputs, failedStep: stepIndex };
    }
    if (dynamic) {
      const collected = dynamicRuntime!.dynamic.collectDynamicResults(step, materialized!.items, outcomes.map((outcome) => ({
        agent: outcome.agent ?? step.parallel.agent,
        exitCode: outcome.exitCode,
        error: outcome.errorMessage,
        structuredOutput: outcome.structuredOutput,
        savedOutputPath: outcome.savedOutputPath,
        output: outcome.summary,
      })));
      dynamicRuntime!.dynamic.validateDynamicCollection(step.collect.outputSchema, collected);
      outputs[step.collect.as] = {
        text: JSON.stringify(collected), structured: collected,
        agent: step.parallel.agent, stepIndex,
      };
    } else {
      outcomes.forEach((outcome, taskIndex) => {
        const name = tasks[taskIndex]?.as;
        if (name) outputs[name] = {
          text: chainOutcomeText(outcome),
          ...(outcome.structuredOutput !== undefined ? { structured: outcome.structuredOutput } : {}),
          agent: outcome.agent,
          stepIndex,
        };
      });
    }
  }
  return { steps, previous, outputs };
}

export async function applyPaneClarification<T extends SubagentParams>(
  params: T,
  show: () => Promise<PaneClarifyResult | undefined>,
): Promise<T | undefined> {
  const result = await show();
  if (!result?.confirmed) return undefined;
  const override = result.behaviorOverrides[0];
  return {
    ...params,
    task: result.templates[0] ?? params.task,
    ...(override?.model ? { model: override.model } : {}),
    ...(override?.output !== undefined ? { output: override.output } : {}),
    ...(override?.reads !== undefined ? { reads: override.reads } : {}),
    ...(override?.progress !== undefined ? { progress: override.progress } : {}),
    ...(override?.skills !== undefined ? { skill: override.skills } : {}),
    clarify: false,
  };
}

export interface PaneRoutingDecision {
  route: "pane" | "native";
  reason?: string;
}

export function decidePaneRouting(params: SubagentParams, muxAvailable: boolean): PaneRoutingDecision {
  if (!muxAvailable) return { route: "native", reason: "no supported terminal multiplexer is available" };
  if (Array.isArray(params.tasks)) {
    for (const task of params.tasks) {
      if (task && typeof task === "object" && !Array.isArray(task)) {
        const keys = Object.keys(task as Record<string, unknown>);
        if (keys.some((key) => !SUPPORTED_PARALLEL_TASK_KEYS.has(key))) {
          return { route: "native", reason: "parallel task uses unsupported orchestration fields" };
        }
      }
    }
  }
  if (!params.tasks && !params.task && !params.chain) return { route: "native", reason: "management action" };
  return { route: "pane" };
}

export function resolvePaneChainDir(params: Pick<SubagentParams, "cwd" | "chainDir">, runId: string): string {
  return params.chainDir
    ? join(resolve(params.cwd ?? process.cwd(), params.chainDir), runId)
    : join(AGENT_DIR, "artifacts", runId, "chain");
}

function requestedPersonas(params: SubagentParams): Array<{ agent: string; cwd: string }> {
  const baseCwd = params.cwd ?? process.cwd();
  if (params.tasks) return (params.tasks as ParallelTaskEntry[]).map((task) => ({
    agent: task.agent!, cwd: resolve(baseCwd, task.cwd ?? "."),
  }));
  if (params.chain) return (params.chain as PaneChainStep[]).flatMap((step) => chainTasks(step).map((task) => ({
    agent: task.agent,
    cwd: resolve(baseCwd, task.cwd ?? (isStaticParallelChainStep(step) ? step.cwd ?? "." : ".")),
  })));
  return params.agent ? [{ agent: params.agent, cwd: baseCwd }] : [];
}

export function applyPersonaDefaultContext(
  params: SubagentParams,
  resolver: (agent: string, cwd: string) => ResolvedPersona | undefined = resolvePersona,
): SubagentParams {
  if (params.context !== undefined) return params;
  return requestedPersonas(params).some(({ agent, cwd }) => resolver(agent, cwd)?.defaultContext === "fork")
    ? { ...params, context: "fork" }
    : params;
}

function requestsFork(params: SubagentParams): boolean {
  return params.context === "fork";
}

export function coerceNativeFallbackInput(params: SubagentParams): { input: SubagentParams; coercedAsync: boolean } {
  if (params.async === false || params.clarify === true || params.async === true) {
    return { input: params, coercedAsync: false };
  }
  return { input: { ...params, async: true }, coercedAsync: true };
}

function normalizeSkills(value: string | string[] | false | undefined): string[] {
  if (value === false || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function resolvePaneSkills(personaSkills: string[], override: string | string[] | false | undefined): string[] {
  if (override === false) return [];
  return [...personaSkills, ...normalizeSkills(override)];
}

function resolveChainSkills(
  personaSkills: string[],
  chainSkills: string[],
  stepSkills: string | string[] | false | undefined,
): string[] {
  if (stepSkills === false) return [];
  return [...new Set([...(stepSkills === undefined ? personaSkills : normalizeSkills(stepSkills)), ...chainSkills])];
}

export function buildPaneTask(task: string, options: {
  skills?: string[];
  acceptance?: unknown;
  reads?: string[] | false;
  progress?: boolean | string;
  cwd: string;
}): string {
  const sections: string[] = [];
  if (options.reads && options.reads.length) {
    sections.push(`Read before starting: ${options.reads.map((path) => resolve(options.cwd, path)).join(", ")}`);
  }
  if (options.progress) {
    const path = typeof options.progress === "string" ? options.progress : "progress.md";
    sections.push(`Maintain progress at: ${resolve(options.cwd, path)}`);
  }
  sections.push(task);
  if (options.acceptance !== undefined) {
    sections.push(`## Acceptance Contract\n${JSON.stringify(options.acceptance, null, 2)}\n\nReturn every requested evidence item. Finish with a fenced JSON block tagged \`acceptance-report\`:\n\`\`\`acceptance-report\n{\n  "criteriaSatisfied": [],\n  "changedFiles": [],\n  "testsAddedOrUpdated": [],\n  "commandsRun": [],\n  "validationOutput": [],\n  "residualRisks": [],\n  "noStagedFiles": true\n}\n\`\`\``);
  }
  return sections.join("\n\n");
}

export function buildPanePromptArgs(skills: string[], taskArtifact: string): string[] {
  return [
    ...(skills.length ? [""] : []),
    ...skills.map((skill) => `/skill:${skill}`),
    `@${taskArtifact}`,
  ];
}

export function formatPaneFailure(agent: string, exitCode: number, screen: string, launchPath: string): string {
  const detail = screen.trim() || "No terminal output was captured.";
  return `${agent} exited with code ${exitCode}.\nLaunch artifact: ${launchPath}\nTerminal output:\n${detail}`;
}

// output must be a concrete path or an explicit opt-out; outputMode must pair
// with a path when file-only (mirrors pi-cohort's validation). `output: true`
// means "use the executor's default path", which the bridge doesn't have.
function normalizeOutput(
  output: string | boolean | undefined,
  outputMode: string | undefined,
  cwd: string,
): { outputPath?: string; outputMode?: "inline" | "file-only" } | undefined {
  if (output === true || (output !== undefined && output !== false && typeof output !== "string")) return undefined;
  if (outputMode !== undefined && outputMode !== "inline" && outputMode !== "file-only") return undefined;
  const outputPath = resolveOutputPath(output, cwd);
  if (outputMode === "file-only" && !outputPath) return undefined;
  return { outputPath, outputMode: outputMode as "inline" | "file-only" | undefined };
}

interface PaneValidationOptions {
  resolvePersona?: (agent: string, cwd: string) => ResolvedPersona | undefined;
  beforeLaunch?: () => void;
}

function outputValidationError(output: unknown, outputMode: unknown): string | undefined {
  if (output === true || (output !== undefined && output !== false && typeof output !== "string")) {
    return "output must be a path string or false.";
  }
  if (outputMode !== undefined && outputMode !== "inline" && outputMode !== "file-only") {
    return `outputMode must be 'inline' or 'file-only', not '${String(outputMode)}'.`;
  }
  if (outputMode === "file-only" && typeof output !== "string") {
    return "file-only outputMode requires an output path.";
  }
  return undefined;
}

export async function validatePaneSubagentRequest(
  rawParams: Record<string, unknown>,
  options: PaneValidationOptions = {},
): Promise<void> {
  const params = rawParams as SubagentParams;
  const cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
  const personaResolver = options.resolvePersona ?? resolvePersona;
  if (params.worktree && !params.tasks && !params.chain) {
    throw new Error("worktree isolation is only supported for parallel calls.");
  }
  if (params.tasks !== undefined && (!Array.isArray(params.tasks) || params.tasks.length === 0)) {
    throw new Error("tasks must be a non-empty array.");
  }
  if (params.chain !== undefined && (!Array.isArray(params.chain) || params.chain.length === 0)) {
    throw new Error("chain must be a non-empty array.");
  }

  const runtime = await loadCohortRuntime(cwd);
  const validateChild = (task: PaneChainTask, childCwd: string, label: string, mode: "single" | "parallel" | "chain", acceptance: unknown): void => {
    if (typeof task.agent !== "string" || !task.agent) throw new Error(`${label} requires a non-empty agent.`);
    if (typeof task.task !== "string" || !task.task) throw new Error(`${label} requires a non-empty task.`);
    const outputError = outputValidationError(task.output, task.outputMode);
    if (outputError) throw new Error(`${label} ${outputError}`);
    const persona = personaResolver(task.agent, childCwd);
    if (!persona) throw new Error(`Unknown agent '${task.agent}' (${label}).`);
    if (persona.disabled) throw new Error(`Agent '${task.agent}' is disabled.`);
    const skills = mode === "chain"
      ? resolveChainSkills(persona.skills ?? [], normalizeSkills(params.skill), task.skill)
      : resolvePaneSkills(persona.skills ?? [], task.skill ?? params.skill ?? params.skills);
    const missing = runtime.skills.resolveSkillsWithFallback(skills, childCwd, cwd).missing;
    if (missing.length) throw new Error(`Skill '${missing[0]}' was not found (${label}).`);
    const effective = runtime.acceptance.resolveEffectiveAcceptance({
      explicit: acceptance,
      agentName: task.agent,
      task: task.task,
      mode,
      async: mode !== "single" || params.async !== false,
      dynamic: false,
    });
    const review = effective.review;
    if (effective.level === "reviewed" && review && review !== false && review.required !== false) {
      const reviewer = review.agent ?? "reviewer";
      const reviewerPersona = personaResolver(reviewer, childCwd);
      if (!reviewerPersona || reviewerPersona.disabled) throw new Error(`Unknown acceptance reviewer agent '${reviewer}' (${label}).`);
      const reviewerSkills = reviewerPersona.skills ?? [];
      const missingReviewerSkills = runtime.skills.resolveSkillsWithFallback(reviewerSkills, childCwd, cwd).missing;
      if (missingReviewerSkills.length) throw new Error(`Skill '${missingReviewerSkills[0]}' was not found (acceptance reviewer '${reviewer}').`);
    }
  };

  if (params.tasks) {
    params.tasks.forEach((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Parallel task ${index + 1} must be an object.`);
      const task = raw as ParallelTaskEntry;
      validateChild(task as PaneChainTask, resolve(cwd, task.cwd ?? "."), `Parallel task ${index + 1}`, "parallel", task.acceptance ?? params.acceptance);
    });
  } else if (params.chain) {
    const chain = params.chain as PaneChainStep[];
    validatePaneChain(chain, runtime.dynamicFanoutMaxItems);
    chain.forEach((step, stepIndex) => chainTasks(step).forEach((task, taskIndex) => {
      const childCwd = resolve(cwd, task.cwd ?? (isStaticParallelChainStep(step) ? step.cwd ?? "." : "."));
      validateChild(task, childCwd, `Chain step ${stepIndex + 1} child ${taskIndex + 1}`, "chain", task.acceptance ?? params.acceptance);
    }));
    chain.forEach((step, stepIndex) => {
      if (!isDynamicPaneChainStep(step) || step.acceptance === undefined) return;
      const effective = runtime.acceptance.resolveEffectiveAcceptance({
        explicit: step.acceptance, agentName: step.parallel.agent, task: step.parallel.task, mode: "chain", async: true, dynamic: true, dynamicGroup: true,
      });
      const review = effective.review;
      if (effective.level === "reviewed" && review && review !== false && review.required !== false) {
        const reviewer = review.agent ?? "reviewer";
        const reviewerPersona = personaResolver(reviewer, cwd);
        if (!reviewerPersona || reviewerPersona.disabled) throw new Error(`Unknown acceptance reviewer agent '${reviewer}' (dynamic chain group ${stepIndex + 1}).`);
        const missing = runtime.skills.resolveSkillsWithFallback(reviewerPersona.skills ?? [], cwd).missing;
        if (missing.length) throw new Error(`Skill '${missing[0]}' was not found (acceptance reviewer '${reviewer}').`);
      }
    });
  } else {
    if (typeof params.agent !== "string" || !params.agent) throw new Error("agent must be a non-empty string.");
    if (typeof params.task !== "string" || !params.task) throw new Error("task must be a non-empty string.");
    const outputError = outputValidationError(params.output, params.outputMode);
    if (outputError) throw new Error(outputError);
    validateChild({ agent: params.agent, task: params.task, output: params.output, outputMode: params.outputMode, skill: params.skill ?? params.skills }, cwd, "Single subagent", "single", params.acceptance);
  }

  resolvePaneLauncher(AGENT_DIR);
  options.beforeLaunch?.();
}

export async function validatePaneRequestBoundary(
  rawParams: Record<string, unknown>,
  options: PaneValidationOptions = {},
): Promise<{ block: true; reason: string } | undefined> {
  try {
    await validatePaneSubagentRequest(rawParams, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { block: true, reason: `Invalid pane subagent request: ${message}` };
  }
}

interface ChildSpec {
  runId: string;
  index: number;
  idKey?: string;
  name: string;
  task: string;
  agent?: string;
  model?: string;
  cwd: string;
  persona?: ResolvedPersona;
  orchestratorTarget: string;
  outputPath?: string;
  outputRelativePath?: string;
  outputMode?: "inline" | "file-only";
  context?: string;
  skills?: string[];
  acceptance?: unknown;
  acceptanceContext?: { mode: "single" | "parallel" | "chain"; async: boolean; dynamic?: boolean; dynamicGroup?: boolean };
  reads?: string[] | false;
  progress?: boolean | string;
  outputSchema?: unknown;
  parentSessionFile?: string;
  availableModels?: Array<{ id: string; provider: string; fullId: string }>;
  preferredModelProvider?: string;
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
  attemptDiagnostics?: string;
  savedOutputPath?: string;
  structuredOutput?: unknown;
  acceptance?: unknown;
}

function childOutcomeFailed(outcome: ChildOutcome): boolean {
  return Boolean(outcome.errorMessage) || outcome.exitCode !== 0;
}

export interface PaneCompletion {
  exitCode: number | null;
  summary: string;
  errorMessage?: string;
  structuredOutput?: unknown;
  acceptance?: any;
}

interface CohortRuntime {
  structured: {
    createStructuredOutputRuntime(schema: any, baseDir?: string): any;
    readStructuredOutput(runtime: any): { value?: unknown; error?: string };
    cleanupStructuredOutputRuntime(runtime: any): void;
    STRUCTURED_OUTPUT_SCHEMA_ENV: string;
    STRUCTURED_OUTPUT_CAPTURE_ENV: string;
  };
  skills: {
    resolveSkillsWithFallback(skillNames: string[], primaryCwd: string, fallbackCwd?: string): { missing: string[] };
  };
  acceptance: {
    resolveEffectiveAcceptance(input: any): any;
    formatAcceptancePrompt(acceptance: any): string;
    evaluateAcceptance(input: any): Promise<any>;
    aggregateAcceptanceReport(input: any): any;
    acceptanceFailureMessage(ledger: any): string | undefined;
  };
  modelFallback: {
    buildModelCandidates(primaryModel: string | undefined, fallbackModels: string[] | undefined, availableModels?: any[], preferredProvider?: string): string[];
    isRetryableModelFailure(error: string | undefined): boolean;
    formatModelAttemptNote(attempt: { model: string; success: boolean; exitCode?: number | null; error?: string }, nextModel?: string): string;
  };
  completionGuard: {
    evaluateCompletionMutationGuard(input: { agent: string; task: string; messages: any[]; tools?: string[] }): {
      expectedMutation: boolean; attemptedMutation: boolean; triggered: boolean;
    };
  };
  dynamic: {
    materializeDynamicParallelStep(step: any, outputs: any, stepIndex: number, config?: any): {
      items: Array<{ index: number; key: string; idKey: string; item: unknown }>;
      parallel: PaneChainTask[];
      collectedOnEmpty?: unknown[];
    };
    collectDynamicResults(step: any, items: any[], results: any[]): any[];
    validateDynamicCollection(schema: any, value: any[]): void;
  };
  validateChainOutputBindings(steps: any[], config?: any): void;
  dynamicFanoutMaxItems?: number;
}

interface CohortClarifyRuntime {
  ChainClarifyComponent: new (...args: any[]) => any;
  resolveStepBehavior(config: any, overrides: any, chainSkills?: string[]) : any;
  discoverAvailableSkills(cwd: string): any[];
  toModelInfo(model: any): any;
}

async function loadCohortClarifyRuntime(cwd: string): Promise<CohortClarifyRuntime> {
  const runtimeExtension = findSubagentsRuntimeExtension(cwd);
  if (!runtimeExtension) throw new Error("pi-cohort clarification UI modules were not found");
  const root = resolve(dirname(runtimeExtension), "../../..");
  const { createJiti } = await import(join(root, "../jiti/lib/jiti.mjs"));
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const [clarify, settings, skills, models] = await Promise.all([
    jiti.import(join(root, "src/runs/foreground/chain-clarify.ts")),
    jiti.import(join(root, "src/shared/settings.ts")),
    jiti.import(join(root, "src/agents/skills.ts")),
    jiti.import(join(root, "src/shared/model-info.ts")),
  ]);
  return {
    ChainClarifyComponent: (clarify as any).ChainClarifyComponent,
    resolveStepBehavior: (settings as any).resolveStepBehavior,
    discoverAvailableSkills: (skills as any).discoverAvailableSkills,
    toModelInfo: (models as any).toModelInfo,
  };
}

function personaAsAgentConfig(name: string, persona: ResolvedPersona): any {
  return { name, description: name, source: "project", ...persona };
}

async function clarifyPaneRequest(params: SubagentParams, ctx: ExtensionContext, chainDir?: string): Promise<SubagentParams | undefined> {
  if (params.clarify !== true || !ctx.hasUI) return params;
  const cwd = params.cwd ?? process.cwd();
  const runtime = await loadCohortClarifyRuntime(cwd);
  const entries = params.tasks
    ? params.tasks as PaneChainTask[]
    : params.chain
      ? (params.chain as PaneChainStep[]).flatMap(chainTasks)
      : [{ agent: params.agent!, task: params.task }];
  const personas = entries.map((entry) => resolvePersona(entry.agent, resolve(cwd, entry.cwd ?? ".")));
  const missing = personas.findIndex((persona) => !persona);
  if (missing >= 0) throw new Error(`Unknown agent: ${entries[missing]!.agent}`);
  const configs = personas.map((persona, index) => personaAsAgentConfig(entries[index]!.agent, persona!));
  const templates = entries.map((entry, index) => entry.task ?? (index === 0 ? params.task ?? "" : "{previous}"));
  const behaviors = configs.map((config, index) => runtime.resolveStepBehavior(config, {
    output: entries[index]!.output,
    outputMode: entries[index]!.outputMode,
    reads: entries[index]!.reads,
    progress: entries[index]!.progress,
    skills: entries[index]!.skill === undefined ? undefined : normalizeSkills(entries[index]!.skill),
    model: entries[index]!.model,
  }));
  const mode = params.tasks ? "parallel" : params.chain ? "chain" : "single";
  const result = await ctx.ui.custom<PaneClarifyResult>(
    (tui, theme, _kb, done) => new runtime.ChainClarifyComponent(
      tui, theme, configs, templates, params.task ?? "", chainDir, behaviors,
      ctx.modelRegistry.getAvailable().map(runtime.toModelInfo), ctx.model?.provider,
      runtime.discoverAvailableSkills(cwd), done, mode,
    ),
    { overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
  );
  if (!result?.confirmed) return undefined;
  const applyEntry = (entry: PaneChainTask, index: number): PaneChainTask => {
    const override = result.behaviorOverrides[index];
    return {
      ...entry,
      task: result.templates[index] ?? entry.task,
      ...(override?.model ? { model: override.model } : {}),
      ...(override?.output !== undefined ? { output: override.output } : {}),
      ...(override?.reads !== undefined ? { reads: override.reads } : {}),
      ...(override?.progress !== undefined ? { progress: override.progress } : {}),
      ...(override?.skills !== undefined ? { skill: override.skills } : {}),
    };
  };
  if (params.tasks) return { ...params, tasks: entries.map(applyEntry), clarify: false };
  if (params.chain) {
    let index = 0;
    const chain = (params.chain as PaneChainStep[]).map((step) => isStaticParallelChainStep(step)
      ? { ...step, parallel: step.parallel.map((entry) => applyEntry(entry, index++)) }
      : isDynamicPaneChainStep(step)
        ? { ...step, parallel: applyEntry(step.parallel, index++) }
        : applyEntry(step, index++));
    return { ...params, chain, clarify: false };
  }
  return applyPaneClarification(params, async () => result);
}

export interface PaneReviewRequest {
  backend: "pane";
  agent: string;
  focus?: string;
  task: string;
}

type PaneReviewer = (request: PaneReviewRequest) => Promise<any>;

const ACCEPTANCE_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    status: { enum: ["no-blockers", "blockers", "needs-parent-decision"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { enum: ["blocker", "non-blocking"] },
          file: { type: "string" },
          issue: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["severity", "issue", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["status", "findings"],
  additionalProperties: false,
};

async function loadInstalledCohortModules(cwd: string, paths: string[]): Promise<any[]> {
  const runtimeExtension = findSubagentsRuntimeExtension(cwd);
  if (!runtimeExtension) throw new Error("pi-cohort runtime modules were not found");
  const root = resolve(dirname(runtimeExtension), "../../..");
  const { createJiti } = await import(join(root, "../jiti/lib/jiti.mjs"));
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  return Promise.all(paths.map((path) => jiti.import(join(root, path))));
}

export async function loadCohortRuntime(cwd = process.cwd()): Promise<CohortRuntime> {
  // pi loads package TypeScript itself, while plain Node refuses to strip types
  // under node_modules. Use pi-cohort's installed jiti dependency so the bridge
  // executes the exact installed runtime in both environments.
  const [structured, skills, acceptance, modelFallback, completionGuard, dynamic, chainOutputs, configModule] = await loadInstalledCohortModules(cwd, [
    "src/runs/shared/structured-output.ts",
    "src/agents/skills.ts",
    "src/runs/shared/acceptance.ts",
    "src/runs/shared/model-fallback.ts",
    "src/runs/shared/completion-guard.ts",
    "src/runs/shared/dynamic-fanout.ts",
    "src/runs/shared/chain-outputs.ts",
    "src/extension/config.ts",
  ]);
  const config = (configModule as any).loadConfig();
  return {
    structured: structured as CohortRuntime["structured"],
    skills: skills as CohortRuntime["skills"],
    acceptance: acceptance as CohortRuntime["acceptance"],
    modelFallback: modelFallback as CohortRuntime["modelFallback"],
    completionGuard: completionGuard as CohortRuntime["completionGuard"],
    dynamic: dynamic as CohortRuntime["dynamic"],
    validateChainOutputBindings: (chainOutputs as any).validateChainOutputBindings,
    dynamicFanoutMaxItems: config.chain?.dynamicFanout?.maxItems,
  };
}

export async function evaluateDynamicGroupAcceptance(
  acceptance: unknown,
  outcomes: ChildOutcome[],
  notes: string,
  cwd: string,
  agentName: string,
  task: string,
): Promise<string | undefined> {
  const runtime = await loadCohortRuntime(cwd);
  const effective = runtime.acceptance.resolveEffectiveAcceptance({
    explicit: acceptance,
    agentName,
    task,
    mode: "chain",
    dynamicGroup: true,
  });
  const report = runtime.acceptance.aggregateAcceptanceReport({
    results: outcomes.map((outcome) => ({
      agent: outcome.agent ?? outcome.name,
      acceptance: outcome.acceptance,
      error: outcome.errorMessage,
      exitCode: outcome.exitCode,
    })),
    notes,
  });
  const ledger = await runtime.acceptance.evaluateAcceptance({
    acceptance: effective,
    output: "",
    report,
    cwd,
  });
  return runtime.acceptance.acceptanceFailureMessage(ledger);
}

export async function finalizePaneOutcome(
  completion: PaneCompletion,
  options: {
    cwd: string;
    agentName: string;
    task: string;
    acceptance?: unknown;
    effectiveAcceptance?: any;
    acceptanceContext?: { mode: "single" | "parallel" | "chain"; async?: boolean; dynamic?: boolean; dynamicGroup?: boolean };
    structuredRuntime?: any;
    reviewerValidator?: (agent: string) => string | undefined;
  },
  runtime: CohortRuntime,
  reviewInPane?: PaneReviewer,
): Promise<PaneCompletion> {
  const finalized = { ...completion };
  if (options.structuredRuntime && finalized.exitCode === 0 && !finalized.errorMessage) {
    const structured = runtime.structured.readStructuredOutput(options.structuredRuntime);
    if (structured.error) {
      finalized.exitCode = 1;
      finalized.errorMessage = structured.error;
    } else {
      finalized.structuredOutput = structured.value;
    }
  }
  const effective = options.effectiveAcceptance ?? runtime.acceptance.resolveEffectiveAcceptance({
    explicit: options.acceptance,
    agentName: options.agentName,
    task: options.task,
    mode: options.acceptanceContext?.mode ?? "single",
    async: options.acceptanceContext?.async ?? true,
    dynamic: options.acceptanceContext?.dynamic,
    dynamicGroup: options.acceptanceContext?.dynamicGroup,
  });
  if (finalized.exitCode !== 0 || finalized.errorMessage) return finalized;
  let ledger = await runtime.acceptance.evaluateAcceptance({
    acceptance: effective,
    output: finalized.summary,
    cwd: options.cwd,
  });
  const review = effective.review;
  let reviewerValidationError: string | undefined;
  if (effective.level === "reviewed" && review && review !== false && review.required !== false &&
      ledger.reviewResult?.status === "needs-parent-decision" && reviewInPane) {
    const reviewerAgent = review.agent ?? "reviewer";
    reviewerValidationError = options.reviewerValidator?.(reviewerAgent);
    const reviewResult = reviewerValidationError
      ? { status: "blockers", findings: [{ severity: "blocker", issue: reviewerValidationError, rationale: "The required independent pane review could not launch." }] }
      : await reviewInPane({
          backend: "pane",
          agent: reviewerAgent,
          focus: review.focus,
          task: [
            "Independently review this completed pane subagent against its acceptance contract.",
            "Return blockers only for failures that prevent acceptance.",
            JSON.stringify({ acceptance: effective, childOutput: finalized.summary, verification: ledger.verifyRuns }, null, 2),
          ].join("\n\n"),
        });
    ledger = await runtime.acceptance.evaluateAcceptance({
      acceptance: effective,
      output: finalized.summary,
      cwd: options.cwd,
      reviewResult,
    });
  }
  finalized.acceptance = ledger;
  const failure = runtime.acceptance.acceptanceFailureMessage(ledger);
  if (failure && ledger.explicit === true) {
    finalized.exitCode = 1;
    finalized.errorMessage = reviewerValidationError ? `${failure}\n${reviewerValidationError}` : failure;
  }
  return finalized;
}

export default function (pi: ExtensionAPI) {
  const nativeFallbacks = new Map<string, string>();
  // Snapshot the mux state once at load. This extension only loads at pi
  // startup, so a session already running when PI_SUBAGENT_MUX is set (or the
  // mux terminal changes underneath it) keeps whatever was true at load time;
  // re-evaluating per session_start wouldn't reflect a mid-session change.
  const activeBackend = getMuxBackend();
  const muxWanted = muxPreference() !== null;

  // Load-time stderr is reserved for an actual misconfiguration: a mux backend
  // was explicitly requested but isn't available, so subagent calls silently
  // fall through to pi-cohort with no other sign why panes aren't appearing.
  // The ordinary active/inactive state lives in the footer status line (see the
  // session_start handler below), not as stderr noise on every boot.
  if (!activeBackend && muxWanted) {
    console.error(
      `[cohort-bridge] PI_SUBAGENT_MUX is set but no mux is available; subagent calls fall through to pi-cohort. ${muxSetupHint()}`,
    );
  }

  // Surface the bridge's state in the footer status line -- glanceable and
  // always current, unlike a one-shot boot message. Re-applied on every
  // session_start so /new or a session switch keeps it. setStatus is a
  // fire-and-forget no-op outside interactive/RPC modes.
  pi.on("session_start", async (_event, ctx) => {
    const { theme } = ctx.ui;
    if (activeBackend) {
      ctx.ui.setStatus(
        "cohort-bridge",
        `${theme.fg("success", "\u25cf")}${theme.fg("dim", ` \u{1F309} ${activeBackend}`)}`,
      );
    } else if (muxWanted) {
      ctx.ui.setStatus(
        "cohort-bridge",
        `${theme.fg("warning", "\u25cf")}${theme.fg("dim", " \u{1F309} mux unavailable")}`,
      );
    } else {
      ctx.ui.setStatus("cohort-bridge", undefined);
    }
  });

  // Surface live cohort-bridge children in `subagent { action: "status" }`.
  // Status falls through to pi-cohort's native executor (only dispatch calls are
  // blocked below), so its result lands here; we append this session's cmux
  // children, which the native async-run registry can't see. Inert when the
  // bridge launched nothing (buildStatusAugmentation returns undefined), so the
  // native path is untouched whenever cohort-bridge is inactive.
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "subagent") return;
    const additions: string[] = [];
    const fallback = nativeFallbacks.get(event.toolCallId);
    if (fallback) {
      additions.push(fallback);
      nativeFallbacks.delete(event.toolCallId);
    }
    const augmentation = buildStatusAugmentation(event.input, [...liveChildren.values()]);
    if (augmentation) additions.push(augmentation);
    if (additions.length === 0) return;
    return { content: [...event.content, { type: "text", text: `\n\n${additions.join("\n\n")}` }] };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "subagent") return;

    let params = event.input as SubagentParams;
    if (!params.task && !params.tasks && !params.chain) return;

    const nativeFallback = (reason: string): void => {
      const { input, coercedAsync } = coerceNativeFallbackInput(params);
      Object.assign(event.input as Record<string, unknown>, input);
      const suffix = coercedAsync ? " Native dispatch was coerced to async:true." : " Explicit foreground/async behavior was preserved.";
      const message = `cohort-bridge native exception: ${reason}.${suffix}`;
      nativeFallbacks.set(event.toolCallId, message);
      ctx.ui.notify(message, "info");
    };

    const invalidRequest = await validatePaneRequestBoundary(event.input as Record<string, unknown>);
    if (invalidRequest) return invalidRequest;

    const routing = decidePaneRouting(params, isMuxAvailable());
    if (routing.route === "native") {
      nativeFallback(routing.reason ?? "unsupported dispatch shape");
      return;
    }

    params = applyPersonaDefaultContext(params);
    const parentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
    if (requestsFork(params) && (!parentSessionFile || !existsSync(parentSessionFile))) {
      return { block: true, reason: "Invalid pane subagent request: fork context requires a persisted parent session." };
    }

    const runId = Math.random().toString(16).slice(2, 10);
    const chainDir = params.chain ? resolvePaneChainDir(params, runId) : undefined;
    try {
      let dynamicFanoutMaxItems: number | undefined;
      if (params.chain) {
        params.chain = expandPaneChainCounts(params.chain as PaneChainStep[]);
        if ((params.chain as PaneChainStep[]).some(isDynamicPaneChainStep)) {
          dynamicFanoutMaxItems = (await loadCohortRuntime(params.cwd ?? process.cwd())).dynamicFanoutMaxItems;
        }
        validatePaneChain(params.chain as PaneChainStep[], dynamicFanoutMaxItems);
      }
      const clarified = await clarifyPaneRequest(params, ctx, chainDir);
      if (!clarified) return { block: true, reason: "Subagent request cancelled in clarification UI." };
      params = clarified;
      Object.assign(event.input as Record<string, unknown>, params);
      if (requestsFork(params) && (!parentSessionFile || !existsSync(parentSessionFile))) {
        return { block: true, reason: "Invalid pane subagent request: fork context requires a persisted parent session." };
      }
      if (params.chain) validatePaneChain(params.chain as PaneChainStep[], dynamicFanoutMaxItems);
      const clarifiedInvalidRequest = await validatePaneRequestBoundary(params as unknown as Record<string, unknown>);
      if (clarifiedInvalidRequest) return clarifiedInvalidRequest;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { block: true, reason: `Invalid pane subagent request: ${message}` };
    }

    // Backend actually chosen for this dispatch (cmux/tmux/zellij/wezterm),
    // used to label user-facing reason messages accurately.
    const mux = getMuxBackend() ?? "mux";

    const orchestratorTarget = resolveIntercomSessionTarget(
      pi.getSessionName(),
      ctx.sessionManager.getSessionId(),
    );
    const availableModels = ctx.modelRegistry.getAvailable().map((model) => ({
      id: model.id,
      provider: model.provider,
      fullId: `${model.provider}/${model.id}`,
    }));
    const preferredModelProvider = ctx.model?.provider;

    // ---- CHAIN mode ----
    if (params.chain) {
      const chain = params.chain as PaneChainStep[];
      mkdirSync(chainDir!, { recursive: true });
      void dispatchChain(pi, ctx, chain, {
        runId,
        originalTask: params.task ?? "",
        cwd: params.cwd ?? process.cwd(),
        chainDir: chainDir!,
        orchestratorTarget,
        parentSessionFile,
        context: params.context,
        skills: normalizeSkills(params.skill),
        availableModels,
        preferredModelProvider,
      });
      return {
        block: true,
        reason: `Rerouted ${chain.length}-step chain to ${mux} panes (cohort-bridge). Result will be delivered as a steer message.`,
      };
    }

    // ---- PARALLEL mode ----
    if (params.tasks) {
      let specs: ChildSpec[] | undefined;
      try {
        specs = buildParallelSpecs(params, runId, orchestratorTarget, parentSessionFile, availableModels, preferredModelProvider);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { block: true, reason: `Invalid pane subagent request: ${message}` };
      }
      if (!specs) {
        return { block: true, reason: "Invalid pane subagent request: parallel request could not be resolved." };
      }

      const concurrency = Math.max(
        1,
        Math.floor(params.concurrency ?? DEFAULT_PARALLEL_CONCURRENCY),
      );
      if (params.worktree) {
        void dispatchParallelWorktree(pi, ctx, specs, concurrency, params.cwd ?? process.cwd());
      } else {
        void dispatchParallel(pi, ctx, specs, concurrency);
      }
      return {
        block: true,
        reason: `Rerouted ${specs.length} parallel subagent(s) to ${mux} panes (cohort-bridge). Aggregate result will be delivered as a steer message.`,
      };
    }

    // ---- SINGLE mode ----
    if (!params.task) return;

    const cwd = params.cwd ?? process.cwd();

    const output = normalizeOutput(params.output, params.outputMode, cwd);
    if (!output) {
      return { block: true, reason: "Invalid pane subagent request: output settings could not be resolved." };
    }

    // Resolve the persona for model/tools/skills/systemPrompt fidelity.
    const persona = params.agent ? resolvePersona(params.agent, cwd) : undefined;
    if (params.agent && !persona) {
      return { block: true, reason: `Invalid pane subagent request: Unknown agent '${params.agent}'.` };
    }
    if (persona?.disabled) {
      return { block: true, reason: `Invalid pane subagent request: Agent '${params.agent}' is disabled.` };
    }

    const requestedSkills = resolvePaneSkills(persona?.skills ?? [], params.skill ?? params.skills);

    const spec: ChildSpec = {
      runId,
      index: 0,
      name: params.name ?? params.agent ?? "subagent",
      task: buildPaneTask(params.task, {
        reads: params.reads,
        progress: params.progress,
        cwd,
      }),
      agent: params.agent,
      model: params.model,
      cwd,
      persona,
      orchestratorTarget,
      outputPath: output.outputPath,
      outputMode: output.outputMode,
      context: params.context,
      skills: requestedSkills,
      acceptance: params.acceptance,
      acceptanceContext: { mode: "single", async: true },
      outputSchema: params.outputSchema,
      parentSessionFile,
      availableModels,
      preferredModelProvider,
    };

    void dispatchSingle(pi, ctx, spec);
    return {
      block: true,
      reason: `Rerouted to ${mux} pane (cohort-bridge). Result will be delivered as a steer message.`,
    };
  });
}

// Builds a validated tasks[] payload and expands count. The tool-call boundary
// rejects invalid current semantics before this builder is reached.
export function buildParallelSpecs(
  params: SubagentParams,
  runId: string,
  orchestratorTarget: string,
  parentSessionFile?: string,
  availableModels?: Array<{ id: string; provider: string; fullId: string }>,
  preferredModelProvider?: string,
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

    const invocationCwd = params.cwd ?? process.cwd();
    const cwd = resolve(invocationCwd, task.cwd ?? ".");
    const persona = resolvePersona(task.agent, cwd);
    if (!persona) throw new Error(`Unknown agent '${task.agent}'.`);

    if (persona.disabled) throw new Error(`Agent '${task.agent}' is disabled.`);
    const output = normalizeOutput(task.output, task.outputMode, cwd);
    if (!output) return undefined;
    const requestedSkills = resolvePaneSkills(persona.skills ?? [], task.skill ?? params.skill ?? params.skills);

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
        outputPath: output.outputPath,
        ...(typeof task.output === "string" && !isAbsolute(task.output) ? { outputRelativePath: task.output } : {}),
        outputMode: output.outputMode,
        context: params.context,
        skills: requestedSkills,
        acceptance: task.acceptance ?? params.acceptance,
        acceptanceContext: { mode: "parallel", async: true },
        reads: task.reads ?? params.reads,
        progress: task.progress ?? params.progress,
        outputSchema: task.outputSchema,
        parentSessionFile,
        availableModels,
        preferredModelProvider,
      });
    }
  }
  if (!params.worktree) assertDistinctOutputPaths(specs);
  return specs;
}

export function assertDistinctOutputPaths(specs: Array<{ agent?: string; outputPath?: string }>): void {
  const seen = new Map<string, { index: number; agent: string }>();
  specs.forEach((spec, index) => {
    if (!spec.outputPath) return;
    const previous = seen.get(spec.outputPath);
    const agent = spec.agent ?? "subagent";
    if (previous) {
      throw new Error(`Parallel tasks ${previous.index + 1} (${previous.agent}) and ${index + 1} (${agent}) resolve output to the same path: ${spec.outputPath}. Use distinct output paths.`);
    }
    seen.set(spec.outputPath, { index, agent });
  });
}

async function dispatchSingle(pi: ExtensionAPI, ctx: ExtensionContext, spec: ChildSpec): Promise<void> {
  const outcome = await runSubagentInPane(spec);
  const content = outcome.errorMessage
    ? `Sub-agent "${outcome.name}" failed (auto-retry exhausted).${outcome.attemptDiagnostics ? `\n\n${outcome.attemptDiagnostics}` : ""}\n\nError: ${outcome.errorMessage}`
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
      outputPath: outcome.savedOutputPath,
      structuredOutput: outcome.structuredOutput,
      acceptance: outcome.acceptance,
    },
  });
}

async function dispatchChain(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  chain: PaneChainStep[],
  options: {
    runId: string;
    originalTask: string;
    cwd: string;
    chainDir: string;
    orchestratorTarget: string;
    parentSessionFile?: string;
    context?: string;
    skills?: string[];
    availableModels?: Array<{ id: string; provider: string; fullId: string }>;
    preferredModelProvider?: string;
  },
): Promise<void> {
  try {
    const result = await executePaneChain(chain, {
      ...options,
      personaResolver: resolvePersona,
      baseSpec: {
        runId: options.runId,
        orchestratorTarget: options.orchestratorTarget,
        parentSessionFile: options.parentSessionFile,
        context: options.context,
        skills: options.skills,
        availableModels: options.availableModels,
        preferredModelProvider: options.preferredModelProvider,
      },
      run: (spec) => runSubagentInPane(withPaneTaskPaths(spec)),
      runWorktreeGroup: async (specs, run, sharedCwd) => {
        const { api, config } = await loadCohortWorktreeRuntime(sharedCwd);
        const result = await runWorktreeLifecycle(
          api,
          sharedCwd,
          `${options.runId}-chain-${specs[0]?.index ?? 0}`,
          specs,
          join(options.chainDir, "worktree-diffs", `group-${specs[0]?.index ?? 0}`),
          run,
          config.worktreeSetupHook
            ? { hookPath: config.worktreeSetupHook, timeoutMs: config.worktreeSetupHookTimeoutMs }
            : undefined,
        );
        if (result.diffSummary && result.outcomes.length) {
          const last = result.outcomes[result.outcomes.length - 1]!;
          result.outcomes[result.outcomes.length - 1] = { ...last, summary: `${last.summary}\n\n${result.diffSummary}` };
        }
        return result.outcomes;
      },
      evaluateGroupAcceptance: (acceptance, outcomes, notes, agentName, task) =>
        evaluateDynamicGroupAcceptance(acceptance, outcomes, notes, options.cwd, agentName, task),
    });
    const failed = result.failedStep !== undefined;
    const content = failed
      ? `Pane chain stopped at step ${result.failedStep! + 1}/${chain.length}.\n\n${result.previous}`
      : `Pane chain completed (${chain.length} steps).\n\n${result.previous}`;
    deliverResult(pi, ctx, {
      customType: "subagent_result",
      content,
      details: {
        mode: "chain",
        runId: options.runId,
        chainDir: options.chainDir,
        failedStep: result.failedStep,
        outputs: result.outputs,
        children: result.steps.map((outcome) => ({
          name: outcome.name,
          agent: outcome.agent,
          index: outcome.index,
          exitCode: outcome.exitCode,
          error: outcome.errorMessage,
          sessionFile: outcome.sessionFile,
          outputPath: outcome.savedOutputPath,
          acceptance: outcome.acceptance,
        })),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deliverResult(pi, ctx, {
      customType: "subagent_result",
      content: `Pane chain validation/setup failed before child launch.\n\n${message}`,
      details: { mode: "chain", runId: options.runId, error: message },
    });
  }
}

export async function loadCohortWorktreeRuntime(cwd = process.cwd()): Promise<{ api: any; config: any }> {
  const [api, configModule] = await loadInstalledCohortModules(cwd, [
    "src/runs/shared/worktree.ts",
    "src/extension/config.ts",
  ]);
  return { api, config: (configModule as any).loadConfig() };
}

function rebaseWorktreePath(path: string, fromCwd: string, agentCwd: string): string {
  if (!isAbsolute(path)) return path;
  const offset = relative(fromCwd, path);
  return offset === ".." || offset.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    ? path
    : resolve(agentCwd, offset);
}

export async function runWorktreeLifecycle<T extends { name: string; agent?: string; cwd: string; outputPath?: string; outputRelativePath?: string; reads?: string[] | false }, R>(
  api: any, cwd: string, runId: string, specs: T[], diffsDir: string,
  run: (specs: T[]) => Promise<R[]>, setupHook?: { hookPath: string; timeoutMs?: number },
): Promise<{ outcomes: R[]; diffSummary: string }> {
  const tasks = specs.map((spec) => ({ agent: spec.agent ?? spec.name, cwd: spec.cwd }));
  const conflict = api.findWorktreeTaskCwdConflict(tasks, cwd);
  if (conflict) throw new Error(api.formatWorktreeTaskCwdConflict(conflict, cwd));
  const setup = api.createWorktrees(cwd, runId, specs.length, { agents: tasks.map((task) => task.agent), ...(setupHook ? { setupHook } : {}) });
  try {
    const isolated = specs.map((spec, index) => {
      const agentCwd = setup.worktrees[index].agentCwd;
      return {
        ...spec,
        cwd: agentCwd,
        ...(spec.outputRelativePath
          ? { outputPath: resolve(agentCwd, spec.outputRelativePath) }
          : spec.outputPath ? { outputPath: rebaseWorktreePath(spec.outputPath, spec.cwd, agentCwd) } : {}),
        ...(spec.reads ? { reads: spec.reads.map((path) => rebaseWorktreePath(path, spec.cwd, agentCwd)) } : {}),
      };
    });
    const outcomes = await run(isolated);
    // Worktrees are temporary. Copy requested output files into the durable run
    // artifact tree before cleanup, rather than publishing them into the shared
    // checkout or returning paths that disappear in finally.
    isolated.forEach((spec, index) => {
      if (!spec.outputPath || !existsSync(spec.outputPath)) return;
      const persisted = join(diffsDir, "worktree-outputs", `child-${index}`, basename(spec.outputPath));
      mkdirSync(dirname(persisted), { recursive: true });
      copyFileSync(spec.outputPath, persisted);
      const outcome = outcomes[index];
      if (outcome && typeof outcome === "object") {
        Object.assign(outcome as object, { savedOutputPath: persisted });
      }
    });
    const diffs = api.diffWorktrees(setup, tasks.map((task) => task.agent), diffsDir);
    return { outcomes, diffSummary: api.formatWorktreeDiffSummary(diffs) };
  } finally { api.cleanupWorktrees(setup); }
}

function withPaneTaskPaths(spec: ChildSpec): ChildSpec {
  return {
    ...spec,
    task: buildPaneTask(spec.task, { reads: spec.reads, progress: spec.progress, cwd: spec.cwd }),
  };
}

async function dispatchParallelWorktree(pi: ExtensionAPI, ctx: ExtensionContext, specs: ChildSpec[], concurrency: number, cwd: string): Promise<void> {
  const started = Date.now();
  try {
    const { api, config } = await loadCohortWorktreeRuntime(cwd);
    const result = await runWorktreeLifecycle(api, cwd, specs[0]!.runId, specs, join(AGENT_DIR, "artifacts", specs[0]!.runId, "worktree-diffs"),
      (isolated) => runPool(isolated.map((spec) => () => runSubagentInPane(withPaneTaskPaths(spec))), concurrency),
      config.worktreeSetupHook ? { hookPath: config.worktreeSetupHook, timeoutMs: config.worktreeSetupHookTimeoutMs } : undefined);
    deliverParallelOutcomes(pi, ctx, specs, result.outcomes, started, result.diffSummary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deliverResult(pi, ctx, { customType: "subagent_result", content: `Parallel worktree setup failed.\n\n${message}`, details: { mode: "parallel", error: message } });
  }
}

async function dispatchParallel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  specs: ChildSpec[],
  concurrency: number,
): Promise<void> {
  const startTime = Date.now();
  const outcomes = await runPool(
    specs.map((spec) => () => runSubagentInPane(withPaneTaskPaths(spec))),
    concurrency,
  );
  deliverParallelOutcomes(pi, ctx, specs, outcomes, startTime);
}

function deliverParallelOutcomes(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  specs: ChildSpec[],
  outcomes: ChildOutcome[],
  startTime: number,
  diffSummary = "",
): void {
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
    content: `${header}\n\n${sections.join("\n\n")}${diffSummary ? `\n\n${diffSummary}` : ""}`,
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
        outputPath: o.savedOutputPath,
        structuredOutput: o.structuredOutput,
        acceptance: o.acceptance,
      })),
    },
  });
}

async function runPool<T>(
  jobs: (() => Promise<T>)[],
  limit: number,
  stopAfter?: (result: T) => boolean,
): Promise<T[]> {
  const results: Array<T | undefined> = new Array(jobs.length);
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped && next < jobs.length) {
      const i = next++;
      const result = await jobs[i]!();
      results[i] = result;
      if (stopAfter?.(result)) stopped = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results.filter((result): result is T => result !== undefined);
}

function formatElapsed(startTime: number): string {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

// A cohort-bridge child that is currently running in its own cmux pane. These
// are live pi sessions that pi-cohort's async-run registry knows nothing about
// (the bridge launches them out-of-band), so `subagent { action: "status" }`
// otherwise reports "No active async runs" while intercom list shows them. We
// track them here -- keyed by childId, populated at pane launch and removed
// when the pane exits -- so status can surface them. In-process state is the
// source of truth over a registry/name scan: this session launched them, so it
// already knows exactly which are live.
interface LiveChild {
  childId: string;
  name: string;
  agent?: string;
  startTime: number;
  activityFile: string;
  intercomSessionName: string;
}

const liveChildren = new Map<string, LiveChild>();

function formatLiveChildLine(child: LiveChild): string {
  const label = child.agent ? `${child.name} (${child.agent})` : child.name;
  const parts = [`- ${child.intercomSessionName}`, "running", label, formatElapsed(child.startTime)];
  // Best-effort current activity from the child's activity file (the same
  // signal that drives HazAT status tracking); absent/stale file just omits it.
  const read = readSubagentActivityFile(child.activityFile, child.childId);
  if (read.ok) {
    const detail = read.activity.toolActive && read.activity.toolName
      ? `tool ${read.activity.toolName}`
      : read.activity.phase;
    if (detail) parts.push(detail);
  }
  return parts.join(" | ");
}

// Builds the section appended to a `subagent { action: "status" }` result so
// cohort-bridge's cmux children show up alongside pi-cohort's native async
// runs. Returns undefined when there's nothing to add -- no live children, or
// a targeted single-run lookup by id -- so the native result passes through
// untouched (and the whole path is inert when the bridge launched nothing).
function buildStatusAugmentation(
  input: Record<string, unknown>,
  children: LiveChild[],
): string | undefined {
  if (input.action !== "status") return undefined;
  if (input.id) return undefined;
  if (children.length === 0) return undefined;
  const lines = children.map(formatLiveChildLine);
  return `cohort-bridge children (this session): ${children.length}\n\n${lines.join("\n")}`;
}

const defaultPaneLifecycleHooks = {
  send: sendLongCommand,
  poll: pollForExit,
  finalize: finalizePaneOutcome,
  loadRuntime: loadCohortRuntime,
  credentialEnvironment: () => process.env,
};
const paneLifecycleHooks = { ...defaultPaneLifecycleHooks };

// Core pane dispatch. Never throws; failures come back in the outcome.
function resolvePaneLauncher(agentDir: string): string {
  const launcher = {
    "agent.anthropic": "pi-anthropic",
    "agent.balanced": "pi-balanced",
    "agent.local": "pi-local",
  }[basename(agentDir)];
  if (!launcher) {
    throw new Error(
      `Unsupported PI_CODING_AGENT_DIR for pane launch: ${agentDir}. ` +
      "Refusing to guess a retention-mode launcher.",
    );
  }
  return launcher;
}

const PANE_CREDENTIAL_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_FABLE_API_KEY",
  "OPENROUTER_API_KEY",
  "GH_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "SLACK_USER_TOKEN",
  "KAGI_API_KEY",
] as const;

interface CredentialHandoff {
  path: string;
  directory: string;
  writer: ChildProcess;
  values: string[];
}

function createCredentialHandoff(
  environment: NodeJS.ProcessEnv,
): CredentialHandoff | undefined {
  const credentials = PANE_CREDENTIAL_NAMES.flatMap((name) => {
    const value = environment[name];
    return value ? [[name, value] as const] : [];
  });
  if (credentials.length === 0) return undefined;

  const directory = mkdtempSync(join(tmpdir(), "cohort-bridge-credentials-"));
  const path = join(directory, "credentials.fifo");
  try {
    chmodSync(directory, 0o700);
    execFileSync("mkfifo", [path]);
    chmodSync(path, 0o600);
    if (!lstatSync(path).isFIFO()) {
      throw new Error("Credential handoff path is not a FIFO");
    }

    const writer = spawn(
      "/bin/sh",
      ["-c", 'exec /bin/cat > "$1"', "cohort-bridge-credential-writer", path],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    writer.on("error", () => {});
    writer.stdin?.on("error", () => {});
    const payload = credentials
      .map(([name, value]) => `export ${name}=${shellEscape(value)}`)
      .join("\n");
    writer.stdin?.end(Buffer.concat([Buffer.from(payload), Buffer.from([0])]));
    const values = [...new Set(credentials.map(([, value]) => value))]
      .sort((left, right) => right.length - left.length);
    return { path, directory, writer, values };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function cleanupCredentialHandoff(handoff: CredentialHandoff | undefined): void {
  if (!handoff) return;
  if (handoff.writer.exitCode === null) handoff.writer.kill("SIGTERM");
  rmSync(handoff.directory, { recursive: true, force: true });
}

function redactHandoffCredentials(
  value: string,
  handoff: CredentialHandoff | undefined,
): string {
  return handoff?.values.reduce(
    (redacted, credential) => redacted.replaceAll(credential, "[REDACTED]"),
    redactCredentialValues(value),
  ) ?? redactCredentialValues(value);
}

export function buildPaneLaunchCommand(
  agentDir: string,
  cwd: string,
  envParts: string[],
  piArgs: string[],
  credentialFifo?: string,
  credentialReadTimeoutSeconds = 10,
): string {
  const executable = credentialFifo
    ? ["pi", ...piArgs].join(" ")
    : `fish -lc ${shellEscape([resolvePaneLauncher(agentDir), ...piArgs].join(" "))}`;
  const assignments = envParts.length > 0 ? `${envParts.join(" ")} ` : "";
  const stripGhosttyIdent =
    "env -u TERM_PROGRAM -u GHOSTTY_RESOURCES_DIR -u GHOSTTY_BIN_DIR ";
  const launch = `cd ${shellEscape(cwd)} && ${assignments}${stripGhosttyIdent}${executable}`;
  if (!credentialFifo) return `${launch}; echo '__SUBAGENT_DONE_'$?'__'`;

  const escapedFifo = shellEscape(credentialFifo);
  const timeout = Number.isFinite(credentialReadTimeoutSeconds) &&
      credentialReadTimeoutSeconds > 0
    ? credentialReadTimeoutSeconds
    : 10;
  return `( exec 3<> ${escapedFifo}; ` +
    `if IFS= read -r -d '' -t ${timeout} -u 3 credential_payload; then ` +
    `eval "$credential_payload"; handoff_status=$?; ` +
    `else echo 'Credential handoff timed out' >&2; handoff_status=1; fi; ` +
    `exec 3>&-; unset credential_payload; rm -f ${escapedFifo}; ` +
    `[ "$handoff_status" -eq 0 ] || exit "$handoff_status"; ${launch} ); ` +
    "echo '__SUBAGENT_DONE_'$?'__'";
}

async function runSubagentInPane(spec: ChildSpec): Promise<ChildOutcome> {
  let runtime: CohortRuntime;
  try {
    runtime = await paneLifecycleHooks.loadRuntime(spec.cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: spec.name, agent: spec.agent, index: spec.index, exitCode: null, elapsedText: "0s",
      summary: "Sub-agent launch refused",
      sessionFile: "",
      errorMessage: redactCredentialValues(message),
    };
  }
  const rawCandidates = runtime.modelFallback?.buildModelCandidates(
    spec.model ?? spec.persona?.model,
    spec.persona?.fallbackModels,
    spec.availableModels,
    spec.preferredModelProvider,
  ) ?? [spec.model ?? spec.persona?.model].filter((model): model is string => Boolean(model));
  const candidates: Array<string | undefined> = rawCandidates.length
    ? rawCandidates.map((model) => applyThinkingSuffix(model, spec.persona?.thinking))
    : [undefined];
  const notes: string[] = [];
  let outcome: ChildOutcome | undefined;
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    outcome = await runSubagentPaneAttempt({ ...spec, model: candidate }, runtime);
    outcome.summary = redactCredentialValues(outcome.summary);
    if (outcome.errorMessage) {
      outcome.errorMessage = redactCredentialValues(outcome.errorMessage);
    }
    if (outcome.exitCode === 0 && !outcome.errorMessage) break;
    const failure = outcome.errorMessage ?? outcome.summary;
    const shouldAdvance = runtime.modelFallback?.isRetryableModelFailure(failure) ||
      isPermanentModelOrAuthFailure(failure);
    if (!shouldAdvance) break;

    const hasNextCandidate = index < candidates.length - 1;
    const nextCandidate = hasNextCandidate ? candidates[index + 1] : undefined;
    const note = runtime.modelFallback?.formatModelAttemptNote({
      model: candidate ?? "default", success: false, exitCode: outcome.exitCode, error: failure,
    }, nextCandidate);
    if (note) notes.push(note);
    if (!hasNextCandidate) break;
  }
  outcome ??= {
    name: spec.name, agent: spec.agent, index: spec.index, exitCode: null, elapsedText: "0s",
    summary: "Sub-agent did not produce a result", sessionFile: "", errorMessage: "Sub-agent did not produce a result.",
  };
  if (notes.length) {
    outcome.attemptDiagnostics = notes.join("\n");
    outcome.summary = `${outcome.attemptDiagnostics}\n\n${outcome.summary}`;
  }
  return outcome;
}

async function runSubagentPaneAttempt(spec: ChildSpec, loadedRuntime: CohortRuntime): Promise<ChildOutcome> {
  const { runId, index, name, task, cwd, persona } = spec;

  // Skip pi's trust prompt for a worktree this session created (see helper).
  // Synchronous and runs before any await, so parallel pool workers can't
  // interleave the trust.json read-modify-write.
  maybeTrustSessionCwd(cwd);

  const childId = `${runId}-${spec.idKey ?? index}`;
  const startTime = Date.now();

  // Refuse unknown presets before creating artifacts or a pane. Return the
  // failure through the normal child outcome path so the parent sees it.
  try {
    resolvePaneLauncher(AGENT_DIR);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name,
      agent: spec.agent,
      index,
      exitCode: null,
      elapsedText: formatElapsed(startTime),
      summary: "Sub-agent launch refused",
      sessionFile: "",
      errorMessage: message,
    };
  }

  let sessionFile = "";
  let surface: string | undefined;
  let systemPromptTempDir: string | undefined;
  let credentialHandoff: CredentialHandoff | undefined;
  let cohortRuntime: CohortRuntime | undefined;
  let structuredRuntime: any;
  try {
  // Session file
  const sessionDir = join(AGENT_DIR, "sessions", "--cohort-bridge--");
  mkdirSync(sessionDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  sessionFile = join(sessionDir, `${timestamp}_${childId}.jsonl`);
  let childEntryBoundary = 0;
  if (spec.context === "fork") {
    if (!spec.parentSessionFile) throw new Error("Forked pane launch requires a persisted parent session file");
    seedSubagentSessionFile({
      mode: "fork",
      parentSessionFile: spec.parentSessionFile,
      childSessionFile: sessionFile,
      childCwd: cwd,
    });
    childEntryBoundary = getNewEntries(sessionFile, 0).length;
  }

  // Activity file (HazAT status tracking)
  const artifactDir = join(AGENT_DIR, "artifacts", runId, `child-${index}`);
  const activityFile = getSubagentActivityFile(artifactDir, childId);
  mkdirSync(dirname(activityFile), { recursive: true });

  let runtimeTask = task;
  cohortRuntime = loadedRuntime;
  const effectiveAcceptance = cohortRuntime.acceptance.resolveEffectiveAcceptance({
    explicit: spec.acceptance,
    agentName: spec.agent ?? name,
    task,
    mode: spec.acceptanceContext?.mode ?? "single",
    async: spec.acceptanceContext?.async ?? true,
    dynamic: spec.acceptanceContext?.dynamic,
    dynamicGroup: spec.acceptanceContext?.dynamicGroup,
  });
  const acceptancePrompt = cohortRuntime.acceptance.formatAcceptancePrompt(effectiveAcceptance);
  if (acceptancePrompt) runtimeTask = `${task}\n${acceptancePrompt}`;
  if (spec.outputSchema !== undefined) {
    structuredRuntime = cohortRuntime.structured.createStructuredOutputRuntime(spec.outputSchema, artifactDir);
  }

  // Write task to an artifact file (avoids shell-escaping multiline strings)
  const modeHint = "Complete your task autonomously.";
  const summaryInstruction = "Your FINAL assistant message should summarize what you accomplished.";
  const taskWithOutput = injectOutputInstruction(runtimeTask, spec.outputPath);
  const fullTask = `${modeHint}\n\n${taskWithOutput}\n\n${summaryInstruction}`;
  const taskArtifact = join(artifactDir, "task.md");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(taskArtifact, fullTask, "utf8");

  const runtimeExtPath = persona ? findSubagentsRuntimeExtension(cwd) : undefined;
  if (persona && !persona.inheritProjectContext && !runtimeExtPath) {
    throw new Error(`Agent '${spec.agent ?? name}' suppresses project context, but pi-cohort's prompt runtime extension was not found.`);
  }

  // Create cmux pane
  surface = createSurface(name);
  // Let the shell start up before sending the command
  await new Promise<void>((resolve) => setTimeout(resolve, 500));

  // Build pi arguments. Resolved parent credentials use a one-shot FIFO below;
  // a keyless parent falls back to its matching fish launcher.
  const parts: string[] = [];
  parts.push("--session", shellEscape(sessionFile));
  // Load HazAT's subagent-done extension so the child can call subagent_done
  parts.push("-e", shellEscape(SUBAGENT_DONE_EXTENSION));

  // Additively load pi-subagents' own prompt-runtime extension when we can
  // find it, so inheritProjectContext/inheritSkills are honored the same way
  // native (non-cmux) children get them. Best-effort: fails open (child sees
  // full inherited context) rather than blocking cmux dispatch entirely.
  if (runtimeExtPath) parts.push("-e", shellEscape(runtimeExtPath));

  const modelArg = spec.model;
  if (modelArg) parts.push("--model", shellEscape(modelArg));

  if (persona && !persona.inheritSkills) parts.push("--no-skills");
  if (persona?.tools?.length) parts.push("--tools", shellEscape(persona.tools.join(",")));

  if (persona?.systemPrompt) {
    systemPromptTempDir = mkdtempSync(join(tmpdir(), "cohort-bridge-"));
    const promptPath = join(systemPromptTempDir, "system-prompt.md");
    writeFileSync(promptPath, persona.systemPrompt, "utf8");
    parts.push(persona.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", shellEscape(promptPath));
  }

  // Artifact-backed launches need an empty prompt before skill commands so pi
  // parses each /skill invocation before loading the @file task.
  for (const promptArg of buildPanePromptArgs(spec.skills ?? [], taskArtifact)) {
    parts.push(shellEscape(promptArg));
  }

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
    // Pin the child to the parent's preset dir. This selects the right
    // settings.json (model map, defaultModel, packages); resolved environment
    // credentials cross separately through the one-shot FIFO.
    `PI_CODING_AGENT_DIR=${shellEscape(AGENT_DIR)}`,
    // Mark the pane child as a real subagent, mirroring pi-cohort's native
    // getSubagentDepthEnv (parent depth + 1). Without this the child looks
    // top-level and its user-scope baton extensions (ticket-baton, here-baton,
    // presence, cmux-workspace-title) all initialize and clobber the parent's
    // shared workspace pill/title, since the pane inherits CMUX_WORKSPACE_ID.
    `PI_SUBAGENT_DEPTH=${(Number(process.env.PI_SUBAGENT_DEPTH ?? "0") || 0) + 1}`,
  ];
  if (spec.agent) envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(spec.agent)}`);
  if (persona && runtimeExtPath) {
    envParts.push(`PI_SUBAGENT_INHERIT_PROJECT_CONTEXT=${persona.inheritProjectContext ? "1" : "0"}`);
    envParts.push(`PI_SUBAGENT_INHERIT_SKILLS=${persona.inheritSkills ? "1" : "0"}`);
  }
  if (structuredRuntime && cohortRuntime) {
    envParts.push(`${cohortRuntime.structured.STRUCTURED_OUTPUT_SCHEMA_ENV}=${shellEscape(structuredRuntime.schemaPath)}`);
    envParts.push(`${cohortRuntime.structured.STRUCTURED_OUTPUT_CAPTURE_ENV}=${shellEscape(structuredRuntime.outputPath)}`);
  }
  for (const name of ["AWS_PROFILE", "GRIDSTRONG_AI_RETENTION", "PI_PRESET", "PI_CACHE_RETENTION"] as const) {
    const value = process.env[name];
    if (value) envParts.push(`${name}=${shellEscape(value)}`);
  }

  credentialHandoff = createCredentialHandoff(
    paneLifecycleHooks.credentialEnvironment(),
  );

  // Strip Ghostty identity in buildPaneLaunchCommand so pi-quiver does not
  // rename the shared workspace pill from the child pane.
  const command = buildPaneLaunchCommand(
    AGENT_DIR,
    cwd,
    envParts,
    parts,
    credentialHandoff?.path,
  );

  const launchScript = join(artifactDir, "launch.sh");

  // Track this child as live so `subagent { action: "status" }` can report it
  // while the pane runs; the finally below removes it once the pane exits.
  liveChildren.set(childId, {
    childId,
    name,
    agent: spec.agent,
    startTime,
    activityFile,
    intercomSessionName,
  });

  const outputBefore = snapshotOutput(spec.outputPath);
  const abort = new AbortController();
    paneLifecycleHooks.send(surface, command, {
      scriptPath: launchScript,
      scriptPreamble: [
        `# subagent-cmux-bridge: ${name}`,
        `# Session: ${sessionFile}`,
        `# Surface: ${surface}`,
      ].join("\n"),
    });

    const result = await paneLifecycleHooks.poll(surface, abort.signal, {
      interval: 1000,
      sessionFile,
    });

    let summary = "Sub-agent exited without output";
    let sessionMessages: any[] = [];
    if (existsSync(sessionFile)) {
      try {
        const entries = getNewEntries(sessionFile, 0);
        sessionMessages = entries
          .slice(childEntryBoundary)
          .filter((entry: any) => entry.type === "message" && entry.message)
          .map((entry: any) => entry.message);
        summary = findLastAssistantMessage(entries) ?? summary;
      } catch {
        // A partial session is expected when the child exits during startup.
      }
    }
    if (result.exitCode !== 0 && summary === "Sub-agent exited without output") {
      const screen = readScreen(surface, 120) ?? "";
      summary = formatPaneFailure(spec.agent ?? name, result.exitCode ?? 1, screen, launchScript);
    }

    summary = redactHandoffCredentials(summary, credentialHandoff);
    let effectiveExitCode = result.exitCode;
    let effectiveError = result.errorMessage
      ? redactHandoffCredentials(result.errorMessage, credentialHandoff)
      : undefined;
    if (effectiveExitCode === 0 && !effectiveError && persona?.completionGuard !== false) {
      const guard = cohortRuntime.completionGuard?.evaluateCompletionMutationGuard({
        agent: spec.agent ?? name,
        task: spec.task,
        messages: sessionMessages,
        tools: persona?.tools,
      });
      if (guard?.triggered) {
        effectiveExitCode = 1;
        effectiveError = "Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes.";
      }
    }

    // Honor `output` only on success -- a failed child's summary is error
    // context, not findings, and must not overwrite the promised file.
    let savedOutputPath: string | undefined;
    if (effectiveExitCode === 0 && !effectiveError && spec.outputPath) {
      const resolved = resolveOutputAfterRun(spec.outputPath, outputBefore, summary);
      savedOutputPath = resolved.savedPath;
      if (resolved.referenceMessage) {
        summary = spec.outputMode === "file-only"
          ? resolved.referenceMessage
          : `${summary}\n\n${resolved.referenceMessage}`;
      } else if (resolved.saveError) {
        summary = `${summary}\n\nOutput file error: ${spec.outputPath}\n${resolved.saveError}`;
      }
    }

    const completion = cohortRuntime
      ? await paneLifecycleHooks.finalize({ exitCode: effectiveExitCode, summary, errorMessage: effectiveError }, {
          cwd,
          agentName: spec.agent ?? name,
          task: spec.task,
          acceptance: spec.acceptance,
          effectiveAcceptance,
          acceptanceContext: spec.acceptanceContext,
          structuredRuntime,
          reviewerValidator: (agent) => {
            const reviewerPersona = resolvePersona(agent, cwd);
            if (!reviewerPersona) return `Reviewer agent '${agent}' was not found.`;
            if (reviewerPersona.disabled) return `Reviewer agent '${agent}' is disabled.`;
            return undefined;
          },
        }, cohortRuntime, async (request) => {
          const reviewerPersona = resolvePersona(request.agent, cwd);
          if (!reviewerPersona || reviewerPersona.disabled) {
            throw new Error(`Reviewer agent '${request.agent}' failed executable validation.`);
          }
          const reviewer = await runSubagentInPane({
            runId: `${runId}-review`,
            index,
            name: `${name} acceptance review`,
            task: request.task,
            agent: request.agent,
            cwd,
            persona: reviewerPersona,
            orchestratorTarget: spec.orchestratorTarget,
            skills: reviewerPersona.skills,
            // The parent run owns this reviewer gate. Disabling acceptance on
            // the reviewer itself prevents a reviewed worker persona from
            // recursively spawning another reviewer.
            acceptance: false,
            outputSchema: ACCEPTANCE_REVIEW_SCHEMA,
            parentSessionFile: spec.parentSessionFile,
            availableModels: spec.availableModels,
            preferredModelProvider: spec.preferredModelProvider,
          });
          return reviewer.structuredOutput ?? {
            status: "needs-parent-decision",
            findings: [{ severity: "blocker", issue: reviewer.errorMessage ?? "Required reviewer did not return a verdict.", rationale: reviewer.summary }],
          };
        })
      : { exitCode: effectiveExitCode, summary, errorMessage: effectiveError };

    return {
      name,
      agent: spec.agent,
      index,
      exitCode: completion.exitCode,
      elapsedText: formatElapsed(startTime),
      summary: redactHandoffCredentials(completion.summary, credentialHandoff),
      sessionFile,
      errorMessage: completion.errorMessage
        ? redactHandoffCredentials(completion.errorMessage, credentialHandoff)
        : undefined,
      savedOutputPath,
      structuredOutput: completion.structuredOutput,
      acceptance: completion.acceptance,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name,
      agent: spec.agent,
      index,
      exitCode: null,
      elapsedText: formatElapsed(startTime),
      summary: "Sub-agent errored before producing output",
      sessionFile,
      errorMessage: redactHandoffCredentials(msg, credentialHandoff),
    };
  } finally {
    liveChildren.delete(childId);
    if (surface) {
      try { closeSurface(surface); } catch (error) {
        console.error("[cohort-bridge] failed to close child surface", error);
      }
    }
    try { cleanupCredentialHandoff(credentialHandoff); } catch (error) {
      console.error("[cohort-bridge] failed to remove credential handoff", error);
    }
    if (systemPromptTempDir) {
      try { rmSync(systemPromptTempDir, { recursive: true, force: true }); } catch (error) {
        console.error("[cohort-bridge] failed to remove temporary system prompt", error);
      }
    }
    if (structuredRuntime && cohortRuntime) {
      try { cohortRuntime.structured.cleanupStructuredOutputRuntime(structuredRuntime); } catch (error) {
        console.error("[cohort-bridge] failed to clean structured-output runtime", error);
      }
    }
  }
}

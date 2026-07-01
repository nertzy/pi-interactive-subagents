/**
 * jacek-bridge.ts
 *
 * Intercepts Jacek's pi-subagents `subagent` tool calls and re-dispatches them
 * through pi-interactive-subagents' cmux machinery.
 *
 * Why: Both packages register a tool named "subagent". Projects that pin
 * pi-subagents as a team contract can't install pi-interactive-subagents as a
 * package without a name collision. This bridge lives as a user-scope extension
 * that silently re-routes single subagent calls so they spawn in real cmux panes
 * and steer results back when done, without touching any checked-in project files.
 *
 * Chain/parallel/acceptance-gate calls from Jacek's API fall through untouched --
 * those have no equivalent here.
 *
 * Setup (see README § Using alongside pi-subagents):
 *   1. Do NOT install pi-interactive-subagents as a pi package (name conflict).
 *   2. Keep pi-subagents installed at project or user scope.
 *   3. Copy or symlink this file to ~/.pi/agent/extensions/jacek-bridge.ts
 *   4. Set PI_SUBAGENT_MUX=cmux (or tmux/zellij/wezterm) in your shell.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Utilities imported from within this package (relative to pi-extension/).
import {
  isMuxAvailable,
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
  resolveIntercomSessionTarget,
  resolvePersona,
  resolveSubagentIntercomTarget,
  type ResolvedPersona,
} from "./subagents/persona-resolve.ts";

// When installed via `pi install`, pi puts the package at:
//   ~/.pi/agent/git/github.com/nertzy/pi-interactive-subagents/
// __dirname resolves to pi-extension/ inside that checkout.
const SUBAGENT_DONE_EXTENSION = join(__dirname, "subagents", "subagent-done.ts");

const AGENT_DIR = join(homedir(), ".pi", "agent");

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "subagent") return;

    const params = event.input as {
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
    };

    // Only intercept single fire-and-forget subagent calls.
    // Chain/parallel modes stay with Jacek's implementation.
    if (params.tasks || params.chain) return;
    if (!params.task) return;

    // Require cmux to be available; fall through to Jacek if not.
    if (!isMuxAvailable()) return;

    const cwd = params.cwd ?? process.cwd();

    // Resolve custom personas (.agents/.pi/agents) for model/tools/skills/
    // systemPrompt fidelity. Builtin personas (implementer, scout, ...) live
    // inside the pinned pi-subagents package and aren't resolvable here --
    // fall through to Jacek's native executor so they still run correctly,
    // just without a cmux pane.
    const persona = params.agent ? resolvePersona(params.agent, cwd) : undefined;
    if (params.agent && !persona) return;

    const name = params.name ?? params.agent ?? "subagent";
    const task = params.task;
    const orchestratorTarget = resolveIntercomSessionTarget(pi.getSessionName(), ctx.sessionManager.getSessionId());

    // Launch async — the block return below prevents Jacek's execute.
    void dispatchSubagent(pi, name, task, params, persona, orchestratorTarget, cwd);

    return {
      block: true,
      reason: `Rerouted to cmux pane (jacek-bridge). Result will be delivered as a steer message.`,
    };
  });
}

async function dispatchSubagent(
  pi: ExtensionAPI,
  name: string,
  task: string,
  params: {
    agent?: string;
    model?: string;
    skills?: string;
    tools?: string;
    cwd?: string;
    systemPrompt?: string;
  },
  persona: ResolvedPersona | undefined,
  orchestratorTarget: string,
  cwd: string,
): Promise<void> {
  // Unique run ID
  const id = Math.random().toString(16).slice(2, 10);
  const startTime = Date.now();

  // Session file
  const sessionDir = join(AGENT_DIR, "sessions", "--jacek-bridge--");
  mkdirSync(sessionDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const sessionFile = join(sessionDir, `${timestamp}_${id}.jsonl`);

  // Activity file (HazAT status tracking)
  const artifactDir = join(AGENT_DIR, "artifacts", id);
  const activityFile = getSubagentActivityFile(artifactDir, id);
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

  const resolvedModel = params.model ?? persona?.model;
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

  const agentLabel = params.agent ?? name;
  const intercomSessionName = resolveSubagentIntercomTarget(id, agentLabel, 0);

  const envParts = [
    `PI_SUBAGENT_NAME=${shellEscape(name)}`,
    `PI_SUBAGENT_ID=${shellEscape(id)}`,
    `PI_SUBAGENT_SESSION=${shellEscape(sessionFile)}`,
    `PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`,
    `PI_SUBAGENT_SURFACE=${shellEscape(surface)}`,
    `PI_SUBAGENT_AUTO_EXIT=1`,
    // Same env contract Jacek's native children get (src/runs/shared/pi-args.ts
    // + subagent-prompt-runtime.ts) -- this is what activates pi-intercom's
    // contact_supervisor tool with no extra wiring, since pi-intercom is a
    // user-scope package that auto-loads for any `pi` invocation.
    `PI_SUBAGENT_ORCHESTRATOR_TARGET=${shellEscape(orchestratorTarget)}`,
    `PI_SUBAGENT_RUN_ID=${shellEscape(id)}`,
    `PI_SUBAGENT_CHILD_AGENT=${shellEscape(agentLabel)}`,
    `PI_SUBAGENT_CHILD_INDEX=0`,
    `PI_SUBAGENT_INTERCOM_SESSION_NAME=${shellEscape(intercomSessionName)}`,
  ];
  if (params.agent) envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  if (persona && runtimeExtPath) {
    envParts.push(`PI_SUBAGENT_INHERIT_PROJECT_CONTEXT=${persona.inheritProjectContext ? "1" : "0"}`);
    envParts.push(`PI_SUBAGENT_INHERIT_SKILLS=${persona.inheritSkills ? "1" : "0"}`);
  }

  const cdPrefix = params.cwd ? `cd ${shellEscape(params.cwd)} && ` : "";
  const command = `${cdPrefix}${envParts.join(" ")} ${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;

  const launchScript = join(artifactDir, "launch.sh");
  sendLongCommand(surface, command, {
    scriptPath: launchScript,
    scriptPreamble: [
      `# subagent-cmux-bridge: ${name}`,
      `# Session: ${sessionFile}`,
      `# Surface: ${surface}`,
    ].join("\n"),
  });

  // Watch for completion (fire-and-forget)
  const abort = new AbortController();
  try {
    const result = await pollForExit(surface, abort.signal, {
      interval: 1000,
      sessionFile,
    });

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const elapsedText = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    let summary = "Sub-agent exited without output";
    if (existsSync(sessionFile)) {
      try {
        const entries = getNewEntries(sessionFile, 0);
        summary = findLastAssistantMessage(entries) ?? summary;
      } catch {}
    }

    closeSurface(surface);
    if (systemPromptTempDir) rmSync(systemPromptTempDir, { recursive: true, force: true });

    const content = result.errorMessage
      ? `Sub-agent "${name}" failed (auto-retry exhausted).\n\nError: ${result.errorMessage}`
      : result.exitCode !== 0
      ? `Sub-agent "${name}" failed (exit ${result.exitCode}, ${elapsedText}).\n\n${summary}`
      : `Sub-agent "${name}" completed (${elapsedText}).\n\n${summary}`;

    pi.sendMessage(
      {
        customType: "subagent_result",
        content,
        display: true,
        details: {
          name,
          task,
          agent: params.agent,
          exitCode: result.exitCode,
          elapsed,
          sessionFile,
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  } catch (err: unknown) {
    try { closeSurface(surface); } catch {}
    if (systemPromptTempDir) { try { rmSync(systemPromptTempDir, { recursive: true, force: true }); } catch {} }
    const msg = err instanceof Error ? err.message : String(err);
    pi.sendMessage(
      {
        customType: "subagent_result",
        content: `Sub-agent "${name}" error: ${msg}`,
        display: true,
        details: { name, task, error: msg },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }
}

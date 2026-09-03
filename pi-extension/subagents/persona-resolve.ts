/**
 * persona-resolve.ts
 *
 * Tactical fidelity bridge for cohort-bridge.ts. Resolves a named agent
 * persona the same way jjuraszek/pi-subagents resolves CUSTOM personas from
 * `.agents`/`.pi/agents` markdown files (discovery precedence, frontmatter
 * fields, agentOverrides fill-if-unset semantics), and locates that
 * package's own `subagent-prompt-runtime.ts` extension so cmux children get
 * the same inheritProjectContext/inheritSkills handling as native
 * (non-cmux) children.
 *
 * Ported, not imported: pi-subagents has no public API for this and is
 * pinned by git tag per project (currently v1.4.5 -- see project
 * .pi/settings.json), so the logic below is a point-in-time copy of
 * src/agents/agents.ts, src/agents/identity.ts, and src/agents/frontmatter.ts.
 * Re-diff against those files before bumping the pinned version anywhere --
 * this file does not track upstream automatically and WILL silently drift.
 *
 * Builtin personas (agents shipped inside the pi-subagents package itself,
 * e.g. delegate/scout/worker) ARE resolved here: they are plain frontmatter
 * markdown in `<pi-subagents>/agents/`, scanned at lowest precedence so
 * `.agents`/`.pi/agents` customs with the same name shadow them -- matching
 * pi-subagents' own mergeAgentsForScope order. Unknown names remain unresolved
 * so the dispatch boundary can reject them before any backend launches.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function applyThinkingSuffix(model: string | undefined, thinking: string | undefined): string | undefined {
  if (!model || !thinking || thinking === "off") return model;
  const colonIdx = model.lastIndexOf(":");
  if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) return model;
  return `${model}:${thinking}`;
}

export interface ResolvedPersona {
  filePath: string;
  model?: string;
  fallbackModels?: string[];
  thinking?: string;
  systemPromptMode: "append" | "replace";
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  defaultContext?: "fresh" | "fork";
  disabled?: boolean;
  systemPrompt: string;
  tools?: string[];
  skills?: string[];
  completionGuard?: boolean;
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const frontmatter: Record<string, string> = {};
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) return { frontmatter, body: normalized };
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return { frontmatter, body: normalized };
  const frontmatterBlock = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trim();
  for (const line of frontmatterBlock.split("\n")) {
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (match) {
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      frontmatter[match[1]] = value;
    }
  }
  return { frontmatter, body };
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function resolveRealPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function findNearestProjectRoot(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    if (isDirectory(path.join(currentDir, ".pi")) || isDirectory(path.join(currentDir, ".agents"))) return currentDir;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function findGitRoot(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    if (isDirectory(path.join(currentDir, ".git"))) return resolveRealPath(currentDir);
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

// Project levels from cwd up to and including the git root, farthest-first.
// Mirrors pi-subagents' enumerateProjectLevels.
function enumerateProjectLevels(cwd: string): string[] {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) {
    const nearest = findNearestProjectRoot(cwd);
    return nearest ? [nearest] : [];
  }
  const levels: string[] = [];
  const seen = new Set<string>();
  let currentDir = cwd;
  while (true) {
    const resolved = resolveRealPath(currentDir);
    const hasMarker = isDirectory(path.join(currentDir, ".pi")) || isDirectory(path.join(currentDir, ".agents"));
    if (hasMarker && !seen.has(resolved)) {
      seen.add(resolved);
      levels.push(currentDir);
    }
    if (resolved === gitRoot) break;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  return levels.reverse();
}

function dedupeByRealPath(dirs: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = dirs.length - 1; i >= 0; i--) {
    const real = resolveRealPath(dirs[i]);
    if (seen.has(real)) continue;
    seen.add(real);
    result.push(dirs[i]);
  }
  return result.reverse();
}

// Resolves the active pi agent directory (the per-preset home holding
// settings.json, auth.json, sessions/, artifacts/). Mirrors pi's own
// PI_CODING_AGENT_DIR handling so a preset launch (e.g. a `pi-<preset>`
// wrapper that exports PI_CODING_AGENT_DIR) resolves to the same dir here as
// inside pi. Exported so cohort-bridge can pin cmux children to the parent's
// dir rather than the default.
export function getAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured === "~") return os.homedir();
  if (configured?.startsWith("~/")) return path.join(os.homedir(), configured.slice(2));
  return configured || path.join(os.homedir(), ".pi", "agent");
}

// Low -> high precedence, matching pi-subagents' builtin < user < project
// merge order (mergeAgentsForScope). Builtins scan first so customs shadow.
function personaSearchDirs(cwd: string): string[] {
  const builtinDir = findSubagentsBuiltinAgentsDir(cwd);
  const userDirs = [path.join(os.homedir(), ".agents"), path.join(getAgentDir(), "agents")];
  if (builtinDir) userDirs.unshift(builtinDir);
  const levels = enumerateProjectLevels(cwd);
  const projectCandidates: string[] = [];
  for (const level of levels) {
    const legacyDir = path.join(level, ".agents");
    const preferredDir = path.join(level, ".pi", "agents");
    if (isDirectory(legacyDir)) projectCandidates.push(legacyDir);
    if (isDirectory(preferredDir)) projectCandidates.push(preferredDir);
  }
  return [...userDirs, ...dedupeByRealPath(projectCandidates)];
}

function normalizePackageName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/-+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/(?:^[-.]+|[-.]+$)/g, "");
}

function buildRuntimeName(localName: string, packageName?: string): string {
  const trimmed = packageName?.trim();
  return trimmed ? `${trimmed}.${localName}` : localName;
}

interface PersonaFile {
  filePath: string;
  frontmatter: Record<string, string>;
  body: string;
  builtin: boolean;
}

// Scans builtin and custom persona directories. Returns the highest-
// precedence match for `runtimeName`, or undefined if not found there.
function findPersonaFile(runtimeName: string, cwd: string): PersonaFile | undefined {
  let found: PersonaFile | undefined;
  const builtinDir = findSubagentsBuiltinAgentsDir(cwd);
  for (const dir of personaSearchDirs(cwd)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!(entry.isFile() || entry.isSymbolicLink())) continue;
      if (!entry.name.endsWith(".md") || entry.name.endsWith(".chain.md") || entry.name === "SKILL.md") continue;
      const filePath = path.join(dir, entry.name);
      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      const { frontmatter, body } = parseFrontmatter(content);
      if (!frontmatter.name || !frontmatter.description) continue;
      const packageName = normalizePackageName(frontmatter.package);
      if (buildRuntimeName(frontmatter.name, packageName) === runtimeName) {
        found = { filePath, frontmatter, body, builtin: builtinDir !== undefined && resolveRealPath(dir) === resolveRealPath(builtinDir) };
      }
    }
  }
  return found;
}

interface AgentOverride {
  model?: string | false;
  fallbackModels?: string[] | false;
  thinking?: string | false;
  systemPromptMode?: "append" | "replace";
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  defaultContext?: "fresh" | "fork" | false;
  disabled?: boolean;
  systemPrompt?: string;
  skills?: string[] | false;
  tools?: string[] | false;
  toolsPrepend?: string[];
  toolsAppend?: string[];
  completionGuard?: boolean;
}

function readJsonBestEffort(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function readAgentOverride(settingsPath: string, localName: string): AgentOverride | undefined {
  const settings = readJsonBestEffort(settingsPath);
  if (!settings || typeof settings !== "object") return undefined;
  const subagents = (settings as Record<string, unknown>).subagents;
  if (!subagents || typeof subagents !== "object") return undefined;
  const overrides = (subagents as Record<string, unknown>).agentOverrides;
  if (!overrides || typeof overrides !== "object") return undefined;
  const entry = (overrides as Record<string, unknown>)[localName];
  return entry && typeof entry === "object" ? (entry as AgentOverride) : undefined;
}

// Project override wins over user override outright (whole-object, not
// merged across scopes), matching pi-cohort. Project levels are considered
// farthest-first, with the nearest definition replacing the whole entry.
function resolveAgentOverride(localName: string, cwd: string): { override?: AgentOverride; disableBuiltins?: boolean } {
  let projectOverride: AgentOverride | undefined;
  let projectDisableBuiltins: boolean | undefined;
  for (const level of enumerateProjectLevels(cwd)) {
    const settings = readJsonBestEffort(path.join(level, ".pi", "settings.json"));
    if (!settings || typeof settings !== "object") continue;
    const subagents = (settings as Record<string, unknown>).subagents;
    if (!subagents || typeof subagents !== "object") continue;
    const value = subagents as Record<string, unknown>;
    if (typeof value.disableBuiltins === "boolean") projectDisableBuiltins = value.disableBuiltins;
    const entry = (value.agentOverrides as Record<string, unknown> | undefined)?.[localName];
    if (entry && typeof entry === "object" && !Array.isArray(entry)) projectOverride = entry as AgentOverride;
  }
  if (projectOverride) return { override: projectOverride };
  if (projectDisableBuiltins === true) return { disableBuiltins: true };

  const userSettingsPath = path.join(getAgentDir(), "settings.json");
  const userSettings = readJsonBestEffort(userSettingsPath);
  const userSubagents = userSettings && typeof userSettings === "object"
    ? (userSettings as Record<string, any>).subagents
    : undefined;
  return {
    override: readAgentOverride(userSettingsPath, localName),
    disableBuiltins: projectDisableBuiltins === false
      ? false
      : typeof userSubagents?.disableBuiltins === "boolean" ? userSubagents.disableBuiltins : undefined,
  };
}

function parseBoolean(value: string | undefined): boolean | undefined {
  return value === "true" ? true : value === "false" ? false : undefined;
}

function parseList(value: string | undefined): string[] | undefined {
  const items = value?.split(",").map((item) => item.trim()).filter(Boolean);
  return items?.length ? items : undefined;
}

function composeTools(base: string[], prepend?: string[], append?: string[]): string[] | undefined {
  const result = [...new Set([...(prepend ?? []), ...base, ...(append ?? [])])];
  return result.length ? result : undefined;
}

export function resolvePersona(runtimeName: string, cwd: string): ResolvedPersona | undefined {
  const persona = findPersonaFile(runtimeName, cwd);
  if (!persona) return undefined;
  const { frontmatter, body } = persona;
  const settings = resolveAgentOverride(frontmatter.name, cwd);
  const override = settings.override;
  const frontmatterTools = parseList(frontmatter.tools);
  const frontmatterSkills = parseList(frontmatter.skill || frontmatter.skills);
  const builtin = persona.builtin;

  // Builtins are replacement-configurable. Custom personas retain their
  // frontmatter and only use settings to fill unset fields; prepend/append
  // still compose around custom tools. This mirrors pi-cohort agents.ts.
  const replace = <T>(base: T | undefined, value: T | false | undefined): T | undefined =>
    builtin && value !== undefined ? (value === false ? undefined : value) : base === undefined && value !== false ? value : base;
  const toolsReplacementApplies = builtin
    ? override?.tools !== undefined
    : frontmatterTools === undefined && override?.tools !== undefined;
  const effectiveTools = toolsReplacementApplies
    ? (override?.tools === false ? [] : override?.tools ?? [])
    : (frontmatterTools ?? []);
  const tools = override?.tools !== undefined || override?.toolsPrepend || override?.toolsAppend
    ? composeTools(effectiveTools, override?.toolsPrepend, override?.toolsAppend)
    : frontmatterTools;
  const skills = replace(frontmatterSkills, override?.skills);
  const frontmatterContext = frontmatter.defaultContext === "fresh" || frontmatter.defaultContext === "fork"
    ? frontmatter.defaultContext
    : undefined;

  return {
    filePath: persona.filePath,
    model: replace(frontmatter.model, override?.model),
    fallbackModels: replace(parseList(frontmatter.fallbackModels), override?.fallbackModels),
    thinking: replace(frontmatter.thinking, override?.thinking),
    systemPromptMode: replace(
      frontmatter.systemPromptMode === "append" || frontmatter.systemPromptMode === "replace" ? frontmatter.systemPromptMode : undefined,
      override?.systemPromptMode,
    ) ?? (frontmatter.name === "delegate" ? "append" : "replace"),
    inheritProjectContext: replace(parseBoolean(frontmatter.inheritProjectContext), override?.inheritProjectContext)
      ?? frontmatter.name === "delegate",
    inheritSkills: replace(parseBoolean(frontmatter.inheritSkills), override?.inheritSkills) ?? false,
    defaultContext: replace(frontmatterContext, override?.defaultContext),
    disabled: builtin ? (override?.disabled ?? settings.disableBuiltins) : replace(parseBoolean(frontmatter.disabled), override?.disabled),
    systemPrompt: replace(body || undefined, override?.systemPrompt) ?? "",
    tools,
    skills,
    completionGuard: replace(parseBoolean(frontmatter.completionGuard), override?.completionGuard),
  };
}

// Jacek's subagent-dispatch package has published under more than one npm
// name over time (pi-subagents, then renamed to pi-cohort) while keeping the
// same "subagent" tool name and on-disk layout (agents/, src/runs/shared/
// subagent-prompt-runtime.ts) -- so match on any known name rather than one
// hardcoded string, or a rename silently breaks builtin-persona resolution
// and inherit-flag fidelity below.
const SUBAGENTS_PACKAGE_NAMES = ["pi-subagents", "pi-cohort"];

// Locates the installed pi-subagents/pi-cohort package root for `cwd`
// (project git/npm install, else user-scope) so the cmux child can
// additively load its subagent-prompt-runtime.ts -- the ONLY mechanism that
// actually honors inheritProjectContext/inheritSkills=false. Pi's own
// `--system-prompt` only replaces the base coding-assistant prompt; project
// AGENTS.md and skills are appended by pi regardless (see `pi --help`,
// docs/usage.md). Without this extension loaded, inherit flags are silently
// ignored and persona isolation degrades to "sees everything" -- fails
// OPEN, not closed, so callers should still proceed with cmux dispatch if
// this returns undefined.
function packageSourceMatches(source: string): boolean {
  const spec = source.replace(/^(npm:|git:)/, "");
  return SUBAGENTS_PACKAGE_NAMES.some((name) => new RegExp(`^${name}(?:@|$)`).test(spec));
}

function npmPackageDirName(source: string): string | undefined {
  const spec = source.replace(/^npm:/, "");
  return SUBAGENTS_PACKAGE_NAMES.find((name) => spec === name || spec.startsWith(`${name}@`));
}

function gitInstallDir(root: string, source: string): string | undefined {
  const spec = source
    .replace(/^git:/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^ssh:\/\//, "")
    .replace(/^git@/, "");
  const withoutRef = spec.split("@")[0];
  const normalized = withoutRef.replace(":", "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length < 2) return undefined;
  return path.join(root, "git", ...segments);
}

// Locates the installed pi-subagents package dir for `cwd` (project git/npm
// install, else user-scope). Shared by the runtime-extension and builtin-
// persona lookups below.
function findSubagentsPackageDir(cwd: string): string | undefined {
  const projectRoot = findNearestProjectRoot(cwd);
  const candidateRoots: { settingsPath: string; installRoot: string }[] = [];
  if (projectRoot) {
    candidateRoots.push({ settingsPath: path.join(projectRoot, ".pi", "settings.json"), installRoot: path.join(projectRoot, ".pi") });
  }
  candidateRoots.push({ settingsPath: path.join(getAgentDir(), "settings.json"), installRoot: getAgentDir() });

  for (const { settingsPath, installRoot } of candidateRoots) {
    const settings = readJsonBestEffort(settingsPath);
    if (!settings || typeof settings !== "object") continue;
    const packages = (settings as Record<string, unknown>).packages;
    if (!Array.isArray(packages)) continue;
    for (const entry of packages) {
      const source = typeof entry === "string" ? entry : (entry as { source?: string } | undefined)?.source;
      if (!source || !packageSourceMatches(source)) continue;
      const npmName = npmPackageDirName(source);
      const pkgDir = source.startsWith("npm:") && npmName
        ? path.join(installRoot, "npm", "node_modules", npmName)
        : gitInstallDir(installRoot, source);
      if (pkgDir && fs.existsSync(pkgDir)) return pkgDir;
    }
  }
  return undefined;
}

function findSubagentsBuiltinAgentsDir(cwd: string): string | undefined {
  const pkgDir = findSubagentsPackageDir(cwd);
  if (!pkgDir) return undefined;
  const agentsDir = path.join(pkgDir, "agents");
  return isDirectory(agentsDir) ? agentsDir : undefined;
}

export function findSubagentsRuntimeExtension(cwd: string): string | undefined {
  const pkgDir = findSubagentsPackageDir(cwd);
  if (!pkgDir) return undefined;
  const runtimePath = path.join(pkgDir, "src", "runs", "shared", "subagent-prompt-runtime.ts");
  return fs.existsSync(runtimePath) ? runtimePath : undefined;
}

// Mirrors pi-subagents' resolveIntercomSessionTarget / resolveSubagentIntercomTarget
// (src/intercom/intercom-bridge.ts) so cmux-dispatched children land on the
// exact same target-naming scheme as Jacek's native children -- this is what
// lets contact_supervisor resolve the right session without any pi-intercom
// config changes.
const DEFAULT_INTERCOM_TARGET_PREFIX = "subagent-chat";

export function resolveIntercomSessionTarget(sessionName: string | undefined, sessionId: string): string {
  const trimmedName = sessionName?.trim();
  if (trimmedName) return trimmedName;
  const normalizedSessionId = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
  return `${DEFAULT_INTERCOM_TARGET_PREFIX}-${normalizedSessionId.slice(0, 8)}`;
}

function sanitizeIntercomTargetPart(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent"
  );
}

export function resolveSubagentIntercomTarget(runId: string, agent: string, index = 0): string {
  return `subagent-${sanitizeIntercomTargetPart(agent)}-${sanitizeIntercomTargetPart(runId)}-${index + 1}`;
}

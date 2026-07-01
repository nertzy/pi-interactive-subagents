/**
 * persona-resolve.ts
 *
 * Tactical fidelity bridge for jacek-bridge.ts. Resolves a named agent
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
 * e.g. implementer/code-reviewer/scout) are intentionally NOT resolved here
 * -- only `.agents`/`.pi/agents` markdown files are scanned. When the
 * requested persona isn't found this way, the caller should fall through to
 * Jacek's native (non-cmux) executor rather than guess at a generic
 * dispatch -- that covers builtins with full fidelity, just without a pane.
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
  thinking?: string;
  systemPromptMode: "append" | "replace";
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  systemPrompt: string;
  tools?: string[];
  skills?: string[];
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

function getAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured === "~") return os.homedir();
  if (configured?.startsWith("~/")) return path.join(os.homedir(), configured.slice(2));
  return configured || path.join(os.homedir(), ".pi", "agent");
}

// Low -> high precedence, matching pi-subagents' resolveUserAgentDirs() +
// resolveNearestProjectAgentDirs(). Builtins are deliberately excluded.
function personaSearchDirs(cwd: string): string[] {
  const userDirs = [path.join(os.homedir(), ".agents"), path.join(getAgentDir(), "agents")];
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
}

// Scans `.agents`/`.pi/agents` only (no builtins). Returns the highest-
// precedence match for `runtimeName`, or undefined if not found there.
function findPersonaFile(runtimeName: string, cwd: string): PersonaFile | undefined {
  let found: PersonaFile | undefined;
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
        found = { filePath, frontmatter, body };
      }
    }
  }
  return found;
}

interface AgentOverride {
  model?: string;
  thinking?: string;
  systemPromptMode?: "append" | "replace";
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  systemPrompt?: string;
  skills?: string[] | false;
  tools?: string[] | false;
  toolsPrepend?: string[];
  toolsAppend?: string[];
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
// merged across scopes -- matches pi-subagents' override precedence). Within
// the chosen scope, each field only fills what the frontmatter left unset.
function resolveAgentOverride(localName: string, cwd: string): AgentOverride | undefined {
  const projectRoot = findNearestProjectRoot(cwd);
  if (projectRoot) {
    const projectOverride = readAgentOverride(path.join(projectRoot, ".pi", "settings.json"), localName);
    if (projectOverride) return projectOverride;
  }
  return readAgentOverride(path.join(getAgentDir(), "settings.json"), localName);
}

export function resolvePersona(runtimeName: string, cwd: string): ResolvedPersona | undefined {
  const persona = findPersonaFile(runtimeName, cwd);
  if (!persona) return undefined;
  const { frontmatter, body } = persona;
  const override = resolveAgentOverride(frontmatter.name, cwd);

  const tools = frontmatter.tools?.split(",").map((t) => t.trim()).filter(Boolean);
  const skillStr = frontmatter.skill || frontmatter.skills;
  const skills = skillStr?.split(",").map((s) => s.trim()).filter(Boolean);

  let resolvedTools = tools && tools.length > 0 ? tools : undefined;
  if (resolvedTools === undefined && (override?.tools !== undefined || override?.toolsPrepend || override?.toolsAppend)) {
    const base = override?.tools === false ? [] : override?.tools ?? [];
    const seen = new Set<string>();
    const merged = [...(override?.toolsPrepend ?? []), ...base, ...(override?.toolsAppend ?? [])].filter((t) =>
      seen.has(t) ? false : (seen.add(t), true),
    );
    resolvedTools = merged.length > 0 ? merged : undefined;
  }

  const resolvedSkills =
    skills && skills.length > 0 ? skills : override?.skills === false ? undefined : (override?.skills as string[] | undefined);

  return {
    filePath: persona.filePath,
    model: frontmatter.model ?? override?.model,
    thinking: frontmatter.thinking ?? override?.thinking,
    systemPromptMode:
      frontmatter.systemPromptMode === "append" || frontmatter.systemPromptMode === "replace"
        ? frontmatter.systemPromptMode
        : (override?.systemPromptMode ?? "replace"),
    inheritProjectContext:
      frontmatter.inheritProjectContext === "true"
        ? true
        : frontmatter.inheritProjectContext === "false"
          ? false
          : (override?.inheritProjectContext ?? false),
    inheritSkills:
      frontmatter.inheritSkills === "true"
        ? true
        : frontmatter.inheritSkills === "false"
          ? false
          : (override?.inheritSkills ?? false),
    systemPrompt: body || override?.systemPrompt || "",
    tools: resolvedTools,
    skills: resolvedSkills,
  };
}

// Locates the installed pi-subagents package root for `cwd` (project
// git/npm install, else user-scope) so the cmux child can additively load
// its subagent-prompt-runtime.ts -- the ONLY mechanism that actually honors
// inheritProjectContext/inheritSkills=false. Pi's own `--system-prompt` only
// replaces the base coding-assistant prompt; project AGENTS.md and skills
// are appended by pi regardless (see `pi --help`, docs/usage.md). Without
// this extension loaded, inherit flags are silently ignored and persona
// isolation degrades to "sees everything" -- fails OPEN, not closed, so
// callers should still proceed with cmux dispatch if this returns undefined.
function packageSourceMatches(source: string): boolean {
  return /pi-subagents(?:@|$)/.test(source.replace(/^(npm:|git:)/, ""));
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

export function findSubagentsRuntimeExtension(cwd: string): string | undefined {
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
      const pkgDir = source.startsWith("npm:")
        ? path.join(installRoot, "npm", "node_modules", "pi-subagents")
        : gitInstallDir(installRoot, source);
      if (!pkgDir) continue;
      const runtimePath = path.join(pkgDir, "src", "runs", "shared", "subagent-prompt-runtime.ts");
      if (fs.existsSync(runtimePath)) return runtimePath;
    }
  }
  return undefined;
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

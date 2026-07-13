/**
 * output.ts
 *
 * Per-call `output` file support for cohort-bridge, ported from pi-cohort's
 * src/runs/shared/single-output.ts (no public API to import).
 *
 * Contract mirrored from pi-cohort: the child is instructed to write its
 * findings to the output path; if it doesn't, the orchestrator persists the
 * child's final summary there instead, so the file always exists on success.
 * Where the bridge deliberately deviates: pi-cohort reads a child-written file
 * back and returns its contents inline, but the bridge steers results into the
 * parent's live context, so it always steers the bounded summary plus a saved
 * -file reference and lets the parent read the file when it needs the bulk.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

// Mirrors pi-cohort's resolveSingleOutputPath: absolute paths pass through,
// relative paths resolve against the task's cwd. Boolean/empty -> undefined
// (callers gate `output: true` before this; the bridge has no default path).
export function resolveOutputPath(output: unknown, cwd: string): string | undefined {
  if (typeof output !== "string" || !output || output === "false" || output === "true") return undefined;
  return isAbsolute(output) ? output : resolve(cwd, output);
}

// Same instruction text pi-cohort injects, so children behave identically
// under either executor.
export function injectOutputInstruction(task: string, outputPath: string | undefined): string {
  if (!outputPath) return task;
  return `${task}\n\n---\n**Output:** Write your findings to: ${outputPath}`;
}

export interface OutputSnapshot {
  exists: boolean;
  mtimeMs?: number;
  size?: number;
}

// Advisory pre-run snapshot; resolveOutputAfterRun reports concrete failures.
export function snapshotOutput(outputPath: string | undefined): OutputSnapshot | undefined {
  if (!outputPath) return undefined;
  try {
    const stat = statSync(outputPath);
    return { exists: true, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { exists: false };
  }
}

export interface ResolvedOutput {
  savedPath?: string;
  saveError?: string;
  // One-line reference for the steered message, e.g.
  // "Output saved to: /path (1.2 KB, 40 lines). Read this file if needed."
  referenceMessage?: string;
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function countLines(text: string): number {
  if (!text) return 0;
  const newlineMatches = text.match(/\r\n|\r|\n/g);
  return (newlineMatches?.length ?? 0) + (/[\r\n]$/.test(text) ? 0 : 1);
}

function referenceFor(savedPath: string, contents: string): string {
  const bytes = Buffer.byteLength(contents, "utf8");
  const lines = countLines(contents);
  return `Output saved to: ${savedPath} (${formatByteSize(bytes)}, ${lines} ${lines === 1 ? "line" : "lines"}). Read this file if needed.`;
}

// Post-run resolution, mirroring pi-cohort's resolveSingleOutput: if the child
// wrote/changed the file, keep its contents; otherwise persist the fallback
// summary so the promised file exists either way.
export function resolveOutputAfterRun(
  outputPath: string | undefined,
  beforeRun: OutputSnapshot | undefined,
  fallbackSummary: string,
): ResolvedOutput {
  if (!outputPath) return {};

  let changedSinceStart = false;
  try {
    const stat = statSync(outputPath);
    changedSinceStart = !beforeRun?.exists
      || stat.mtimeMs !== beforeRun.mtimeMs
      || stat.size !== beforeRun.size;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      return { saveError: `Failed to inspect output file: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  if (changedSinceStart) {
    try {
      const contents = readFileSync(outputPath, "utf8");
      return { savedPath: outputPath, referenceMessage: referenceFor(outputPath, contents) };
    } catch (error) {
      return { saveError: `Failed to read changed output file: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, fallbackSummary, "utf8");
    return { savedPath: outputPath, referenceMessage: referenceFor(outputPath, fallbackSummary) };
  } catch (error) {
    return { saveError: error instanceof Error ? error.message : String(error) };
  }
}

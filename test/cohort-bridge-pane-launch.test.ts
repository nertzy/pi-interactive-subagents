import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __test__ } from "../pi-extension/cohort-bridge.ts";

const { buildPanePiCommand, resolvePresetLauncher } = __test__;

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

function makeAgentDir(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "cohort-bridge-pane-launch-test-"));
  tempDirs.push(root);
  const agentDir = join(root, name);
  mkdirSync(agentDir);
  return agentDir;
}

function makePresetAgentDir(name: string): string {
  const home = mkdtempSync(join(tmpdir(), "cohort-bridge-pane-launch-home-"));
  tempDirs.push(home);
  process.env.HOME = home;
  const agentDir = join(home, ".pi", name);
  mkdirSync(agentDir, { recursive: true });
  return agentDir;
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("cohort-bridge pane launcher", () => {
  it("maps canonical agent directories to Grant's preset launchers", () => {
    assert.equal(resolvePresetLauncher(makePresetAgentDir("agent.non-zdr")), "pi-non-zdr");
    assert.equal(resolvePresetLauncher(makePresetAgentDir("agent.zdr")), "pi-zdr");
    assert.equal(resolvePresetLauncher(makePresetAgentDir("agent.local")), "pi-local");
  });

  it("resolves an agent.anthropic symlink to the non-ZDR preset launcher", () => {
    const nonZdrDir = makePresetAgentDir("agent.non-zdr");
    const anthropicDir = join(nonZdrDir, "..", "agent.anthropic");
    symlinkSync(nonZdrDir, anthropicDir);

    assert.equal(realpathSync(anthropicDir), realpathSync(nonZdrDir));
    assert.equal(resolvePresetLauncher(anthropicDir), "pi-non-zdr");
  });

  it("uses raw pi and pins unknown agent directories", () => {
    const agentDir = makeAgentDir("agent.custom");

    assert.equal(
      buildPanePiCommand(agentDir, ["--session", "/tmp/child session.jsonl"]),
      `PI_CODING_AGENT_DIR='${agentDir}' pi '--session' '/tmp/child session.jsonl'`,
    );
  });

  it("does not treat a custom same-basename directory as a known preset", () => {
    makePresetAgentDir("agent.non-zdr");
    const customAgentDir = makeAgentDir("agent.non-zdr");

    assert.equal(resolvePresetLauncher(customAgentDir), undefined);
    assert.equal(
      buildPanePiCommand(customAgentDir, ["--session", "/tmp/child session.jsonl"]),
      `PI_CODING_AGENT_DIR='${customAgentDir}' pi '--session' '/tmp/child session.jsonl'`,
    );
  });

  it("fails loudly without invoking raw pi when the preset launcher function is missing", () => {
    const agentDir = makePresetAgentDir("agent.non-zdr");
    const root = join(agentDir, "..");
    const fishConfigDir = join(root, "config", "fish");
    const fakeBinDir = join(root, "bin");
    const piInvokedFile = join(root, "pi-invoked");
    const args = ["--session", "/tmp/child session.jsonl", "@task with 'quotes'.md"];
    mkdirSync(fishConfigDir, { recursive: true });
    mkdirSync(fakeBinDir);
    writeFileSync(
      join(fishConfigDir, "config.fish"),
      `set -gx PATH '${fakeBinDir}' $PATH\n# No preset launcher function.\n`,
    );
    const fakePi = join(fakeBinDir, "pi");
    writeFileSync(fakePi, "#!/bin/sh\ntouch \"$PANE_PI_INVOKED_FILE\"\n");
    chmodSync(fakePi, 0o755);

    const result = spawnSync("/bin/sh", ["-c", buildPanePiCommand(agentDir, args)], {
      encoding: "utf8",
      env: {
        ...process.env,
        PANE_PI_INVOKED_FILE: piInvokedFile,
        PATH: `${fakeBinDir}:${process.env.PATH}`,
        XDG_CONFIG_HOME: join(root, "config"),
      },
    });

    assert.equal(result.status, 127);
    assert.match(
      result.stderr,
      /cohort-bridge: preset launcher pi-non-zdr is unavailable/,
    );
    assert.equal(existsSync(piInvokedFile), false);
  });

  it("invokes a known preset through a login fish and forwards every pi argument positionally", () => {
    const agentDir = makePresetAgentDir("agent.non-zdr");
    const args = [
      "--session",
      "/tmp/child session.jsonl",
      "--model",
      "provider/model:thinking",
      "@task with 'quotes' and $(shell syntax).md",
    ];

    assert.equal(
      buildPanePiCommand(agentDir, args),
      "fish -lc 'if functions -q pi-non-zdr; pi-non-zdr $argv[2..-1]; else; " +
        "echo '\\''cohort-bridge: preset launcher pi-non-zdr is unavailable'\\'' >&2; " +
        "exit 127; end' -- " +
        `'${agentDir}' '--session' '/tmp/child session.jsonl' '--model' ` +
        "'provider/model:thinking' '@task with '\\''quotes'\\'' and $(shell syntax).md'",
    );
  });

  it("smoke-runs the fish launcher without serializing credentials", () => {
    const agentDir = makePresetAgentDir("agent.non-zdr");
    const root = join(agentDir, "..");
    const fishConfigDir = join(root, "config", "fish");
    const receivedArgsFile = join(root, "received-args");
    const credential = "test-only-secret-that-must-not-be-serialized";
    const args = [
      "--session",
      "/tmp/child session.jsonl",
      "-e",
      "/tmp/subagent-done.ts",
      "--model",
      "anthropic/example:thinking",
      "@task with 'quotes' and $(shell syntax).md",
    ];
    mkdirSync(fishConfigDir, { recursive: true });
    writeFileSync(
      join(fishConfigDir, "config.fish"),
      "function pi-non-zdr\n  printf '%s\\n' $argv >$PANE_ARGS_FILE\nend\n",
    );

    const command = buildPanePiCommand(agentDir, args);
    assert.doesNotMatch(command, new RegExp(credential));
    assert.doesNotMatch(command, /(?:ANTHROPIC_API_KEY|KAGI_API_KEY|SLACK_USER_TOKEN)=/);

    execFileSync("/bin/sh", ["-c", command], {
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: credential,
        PANE_ARGS_FILE: receivedArgsFile,
        XDG_CONFIG_HOME: join(root, "config"),
      },
    });

    assert.deepEqual(readFileSync(receivedArgsFile, "utf8").trimEnd().split("\n"), args);
  });
});

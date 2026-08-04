# Preserve preset authentication for cmux subagents implementation plan

> **REQUIRED SUB-SKILL:** Use the subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Launch cmux-pane subagents through the active preset's fish launcher so provider credentials and retention posture are injected without persisting secrets.

**Architecture:** A pure launcher resolver maps canonical pi agent-directory basenames to the corresponding fish command. The pane command builder runs known presets through `fish -lc`; unknown agent directories retain the portable raw-`pi` path.

**Tech Stack:** TypeScript, Node.js test runner, fish shell, cmux

**Spec:** `doc/specs/2026-08-04-cmux-subagent-auth-env.md`

---

## Files

**Create:**
- `test/cohort-bridge-pane-launch.test.ts`

**Modify:**
- `pi-extension/cohort-bridge.ts`
- `README.md`

**Delete:** none

## Wave 1 - Preset-aware pane launch

### Task 1: Resolve and invoke preset fish launchers

**TDD scenario:** New behavior - full TDD cycle

**Files:**
- Create: `test/cohort-bridge-pane-launch.test.ts`
- Modify: `pi-extension/cohort-bridge.ts:650-780`

- [ ] **Step 1: Write failing launcher-resolution tests**

  Add table-driven tests asserting that canonical directories `agent.non-zdr`, `agent.zdr`, and `agent.local` select `pi-non-zdr`, `pi-zdr`, and `pi-local`. Add a symlink test proving a temporary `agent.anthropic` symlink to `agent.non-zdr` resolves to `pi-non-zdr`. Add an unknown-directory test proving it selects raw `pi`.

- [ ] **Step 2: Run the tests and confirm red**

  Run: `npm test -- --test-name-pattern='pane launcher'`

  Expected: FAIL because the launcher resolver and command builder are not exported.

- [ ] **Step 3: Implement the minimal resolver and command builder**

  Add exported pure helpers that canonicalize the agent directory with `realpathSync`, map known basenames to fish launchers, and construct either:

  ```text
  fish -lc '<launcher> "$argv"' -- <escaped pi arguments>
  ```

  or the existing raw `PI_CODING_AGENT_DIR=... pi ...` command for unknown directories. Keep all resolved credential values outside the command and artifact.

- [ ] **Step 4: Route `runSubagentInPane` through the command builder**

  Replace the inline raw `pi` assembly at the final launch boundary. Preserve every existing child metadata variable, Ghostty identity removal, working directory, session path, extension, model, tools, prompt, and completion marker.

- [ ] **Step 5: Run focused tests and confirm green**

  Run: `npm test -- --test-name-pattern='pane launcher'`

  Expected: all pane-launch tests PASS.

- [ ] **Step 6: Smoke-run the generated fish path**

  In a temporary fish configuration directory, define a fake `pi-non-zdr` function that records only argument names and non-secret sentinel values. Execute the exact generated command and assert the fake launcher receives the session, extension, model, and prompt arguments. Assert the generated launch text does not contain an `ANTHROPIC_API_KEY` assignment or sentinel credential value.

  Expected: fake launcher exits 0; argument assertions pass; secret-string scan has no matches.

## Wave 2 - Documentation

Depends on Wave 1: document the implemented fallback and launcher behavior.

### Task 2: Document pane authentication behavior

**TDD scenario:** Trivial documentation change - use judgment

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a concise setup note**

  Document that Grant's known pi preset directories launch through `pi-non-zdr`, `pi-zdr`, or `pi-local` so their fish startup injects runtime credentials; other directories continue using raw `pi` with `PI_CODING_AGENT_DIR`.

- [ ] **Step 2: Verify the documented command names against source**

  Run: `rg --line-number 'pi-non-zdr|pi-zdr|pi-local|PI_CODING_AGENT_DIR' README.md pi-extension/cohort-bridge.ts`

  Expected: README names exactly the commands and fallback implemented by the bridge.

## Wave 3 - Full verification

Depends on Waves 1-2.

### Task 3: Verify the package and live cmux path

**TDD scenario:** Modifying tested integration code - run the complete validation surface

**Files:**
- Modify: none

- [ ] **Step 1: Run the full automated suite**

  Run: `npm test`

  Expected: all tests PASS with zero failures.

- [ ] **Step 2: Run TypeScript validation**

  Run: `npm run typecheck`

  Expected: TypeScript exits 0 with no diagnostics.

- [ ] **Step 3: Launch an Anthropic child through cohort-bridge**

  From a non-ZDR pi parent, dispatch a minimal cmux-pane subagent with `model: "anthropic/claude-fable-5"` and ask it to return a fixed non-secret token.

  Expected: the child creates a session JSONL, returns the token, and its generated `launch.sh` invokes `fish -lc` with `pi-non-zdr` while containing no `ANTHROPIC_API_KEY` value or assignment.

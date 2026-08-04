# Preserve preset authentication for cmux subagents

## Context

`cohort-bridge` creates a fresh cmux terminal and invokes raw `pi` from a generated Bash launch script. `PI_CODING_AGENT_DIR` selects the correct preset settings directory, but raw `pi` bypasses Grant's fish launch functions. Those functions inject the selected preset's runtime credentials and retention posture, including `ANTHROPIC_API_KEY`. A pane-launched Anthropic child therefore exits before creating a session even though the parent pi process is authenticated.

The generated launch script must not contain resolved credentials. Launch scripts persist under the pi artifacts directory, and commands may also appear in terminal scrollback or shell history.

## Design

The bridge will map the active agent directory to Grant's existing fish launcher:

- `~/.pi/agent.non-zdr` -> `pi-non-zdr`
- `~/.pi/agent.zdr` -> `pi-zdr`
- `~/.pi/agent.local` -> `pi-local`

The mapping is based on the canonical basename after resolving symlinks so the retired `agent.anthropic` compatibility path selects `pi-non-zdr`. The generated Bash script will invoke the selected launcher through `fish -lc` and pass the child's pi arguments as positional parameters. This lets the existing launcher resolve credentials at process start without serializing them into the artifact.

Unknown agent directories retain the current raw `pi` invocation with an explicit `PI_CODING_AGENT_DIR`. This preserves portability for users who do not have Grant's personal fish launchers.

## Out of scope

This change does not modify the fish launcher functions, their credential sources, or any preset's retention posture. It does not add launcher conventions for agent directories outside the three known presets, and it does not persist or directly forward resolved credential values.

## Error handling

Shell arguments remain individually escaped before entering the fish command. If the selected fish launcher is missing, the child pane fails loudly rather than falling back to unauthenticated raw `pi`, because silent fallback would reproduce the security and authentication bug.

## Testing

Unit tests will cover:

- each known preset directory selecting its corresponding fish launcher;
- symlinked `agent.anthropic` selecting `pi-non-zdr`;
- unknown agent directories retaining raw `pi` plus `PI_CODING_AGENT_DIR`;
- generated commands passing model, thinking, session, and prompt arguments without embedding any credential value.

The exact generated launch command will be smoke-run through fish with a fake launcher function so the runtime path, not only string construction, is exercised.

## Documentation impact

- Feature / user-facing docs introduced: none
- Materially amended existing docs: README setup note for pane authentication
- Derived / memory docs invalidated: none

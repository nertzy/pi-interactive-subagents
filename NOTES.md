# Notes / known issues

Durable observations that don't (yet) have a code fix in this repo. Each entry
is dated and describes the symptom, the root cause as understood, and the
suggested direction.

## `intercom list` shows a truncated session ID that `send`/`ask` can't resolve (2026-07-09)

**Symptom.** Cross-session `intercom send` / `intercom ask` fails with "Session
not found" when the `to:` target is the ID copied from `intercom list`, even for
a peer the list just returned. Addressing the same live peer by **name**
succeeds.

**Controlled test** (same target session, same moment):

- `to: "Deprecate pickup_without_unit column E-2121"` (name) -> "Message sent" ✅
- `to: "4ef27fa3"` (ID from `intercom list`) -> "Session not found" ❌

**Root cause.** `intercom list` prints an **8-char truncated prefix** of the
session ID (e.g. `4ef27fa3`), but `send`/`ask` resolve the target against the
**full** session UUID. `intercom status` shows the full form for the current
session (e.g. `52dc8b4b-e38f-4b06-aaa6-01198a1a4db9`); the `list` value is the
first segment's prefix, not a valid addressing key. So a caller that does the
obvious thing -- read the ID from `list`, pass it as `to:` -- always fails,
while `list` itself (no target resolution) always works. The pi-intercom README
instructs users to "target the stable session ID shown by `list`/`status`," but
the ID `list` shows is unsendable; only the full ID (from `status`) or the
session name resolves.

Note this is intercom's own session-ID namespace, distinct from the pi session
UUID that the `here-baton` extension records (baton holder `019f47fe-…` vs the
same session's intercom short ID `4917b1a7`). Do **not** try to address intercom
by the baton's pi-session UUID -- that is a third value and also fails; the fix
is not "reconcile intercom onto the baton UUID."

**Consequence.** Any agent that learns a peer from `intercom list` and targets
the shown ID cannot deliver. Broadcast helpers that map over `list` results and
send to a per-entry ID silently fail for every peer. The reliable path today is
**address by session name** (the README's own examples do this), or by the full
UUID from `status` (rarely available for a *remote* peer, since `list` truncates
it).

**Suggested direction (in the `pi-intercom` package, not this repo).** Either
(a) have `list` print the full session ID it tells users to target, or (b) have
`send`/`ask` accept the 8-char prefix `list` displays (unique-prefix match, fail
on ambiguity). (a) is the smaller, less surprising fix. Until then, callers
should prefer name-addressing and treat the `list` ID as display-only.
Recorded here because it surfaced alongside the cohort-bridge result-delivery
work and shares the "delivery across sessions is flaky" theme.

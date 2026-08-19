# Reconciliation: burnboard reader vs ccusage

Date: 2026-08-19. Machine: the operator's Mac (darwin, arm64).
Reader under test: `initiatives/burnboard/cli/index.mjs`.
Reference: ccusage 20.0.20 (native binary distribution), run as
`npx -y ccusage@latest`.

## Verdict

All four Claude token buckets match ccusage exactly, token for token.
Delta is 0.0000 percent on every bucket. The launch gate allows 2 percent.
The gate passes on every bucket.

## Method

The transcript files grow while any session runs. Each comparison ran the
two tools back to back to bound drift. Two independent comparisons ran.

Comparison 1, 18:54 UTC. Commands, in order:

1. `npx -y ccusage@latest claude daily --json`
2. `node index.mjs --json`

Comparison 2, 18:56 UTC. Commands, in order:

1. `npx -y ccusage@latest --json`
2. `node index.mjs --json`

The human view ran as `npx -y ccusage@latest`. Its header reads
"Detected: Claude, Codex, OpenClaw". That header matters. See finding 1.

## Numbers, comparison 1 (ccusage claude daily --json)

| bucket       | burnboard      | ccusage        | delta     | gate (2%) |
|--------------|---------------:|---------------:|----------:|-----------|
| input        | 10,237,186     | 10,237,186     | +0.0000%  | PASS      |
| output       | 88,345,198     | 88,345,198     | +0.0000%  | PASS      |
| cache create | 591,865,619    | 591,865,619    | +0.0000%  | PASS      |
| cache read   | 20,198,052,458 | 20,198,052,458 | +0.0000%  | PASS      |

Burnboard counted 113,539 unique entries across 3,531 files and skipped
134,611 duplicate lines.

## Numbers, comparison 2 (default ccusage --json, Claude rows extracted)

| bucket       | burnboard      | ccusage        | delta     | gate (2%) |
|--------------|---------------:|---------------:|----------:|-----------|
| input        | 10,237,188     | 10,237,188     | +0.0000%  | PASS      |
| output       | 88,346,865     | 88,346,865     | +0.0000%  | PASS      |
| cache create | 591,866,530    | 591,866,530    | +0.0000%  | PASS      |
| cache read   | 20,198,163,374 | 20,198,163,374 | +0.0000%  | PASS      |

The numbers differ from comparison 1 by up to 110,916 tokens on cache
read. That is live drift between 18:54 and 18:56, not a counting
difference. Within each back-to-back pair the observed drift was zero.

## Findings from the digging

Three counting traps stood between the first draft and exact agreement.
Each one was found by comparing against ccusage and tracing the delta to
raw lines.

### 1. The default ccusage report mixes agents

`npx -y ccusage@latest --json` reports all detected agent CLIs in one
grand total. On this machine that is Claude, Codex, and OpenClaw. The
grand total shows input 1,511,137,249. The Claude share is 10,237,188.
A naive comparison against the grand total shows input off by a factor
of 148. That is agent mixing, not a counting error. The Claude-only
numbers come from `ccusage claude daily --json`, or from the default
report by summing `modelBreakdowns` rows whose `modelName` starts with
`claude`. Both extraction paths gave the same result.

### 2. Duplicate lines are streaming snapshots, and the winner matters

The same `(message.id, requestId)` pair appears on many lines. On this
machine 87,162 of 113,517 keys had more than one line, and 36,173 keys
had lines with different usage values. The lines are streaming
snapshots of one message. Input and cache fields stay constant across
snapshots. Output grows. Specimen key
`msg_011Cdy3s2cG82CofbbonooBz:req_011Cdy3s1n9oLkcZR5CsFwMw` carries
output 7, 7, 7, then 303. A first-line-wins dedupe keeps the partial
snapshot and undercounted output by 38.7 percent. The reader keeps the
snapshot with the largest output per key. That policy reproduced the
ccusage output total exactly.

### 3. cache_creation_input_tokens is sometimes zeroed

27 lines on this machine carry `cache_creation_input_tokens: 0` while
the `cache_creation` breakdown object carries the real value. Specimen:
field 0, `ephemeral_1h_input_tokens` 6,030, written by Claude Code
version 2.1.234 (23 lines) and 2.1.235 (4 lines), all dated 2026-08-18
or later. The gap summed to 279,981 raw tokens, 71,945 after dedupe,
which is 0.012 percent of the bucket. ccusage counts the breakdown. The
reader now takes the larger of the canonical field and the breakdown
sum. On the other 248,368 lines the two values agree exactly.

## Checks that found nothing

- Timezone bucketing: not a factor. Totals were compared, not daily rows.
- `<synthetic>` model rows: all carry zero usage. Inclusion cannot move
  any bucket. The reader skips them.
- A second transcript root at `~/.config/claude/projects`: does not
  exist on this machine.

## Out of scope

Codex totals were not reconciled. ccusage buckets Codex tokens under
different names and semantics than the rollout files use, and the
launch gate names Claude token counts. The burnboard Codex reader sums
per-event deltas of the cumulative `total_token_usage` counter and was
verified against the raw specimen arithmetic only. Reconciling Codex
against `ccusage codex` is open work before any Codex number publishes
on a leaderboard.

## Independent verification

The build ran in a dispatched subagent. Its numbers are claims until
checked. The dispatching session re-ran comparison 1 itself at 18:59 UTC,
a fresh back-to-back pair, same commands.

| bucket       | burnboard      | ccusage        | delta     | gate (2%) |
|--------------|---------------:|---------------:|----------:|-----------|
| input        | 10,237,202     | 10,237,202     | +0.0000%  | PASS      |
| output       | 88,355,503     | 88,355,503     | +0.0000%  | PASS      |
| cache create | 591,880,769    | 591,880,769    | +0.0000%  | PASS      |
| cache read   | 20,198,988,788 | 20,198,988,788 | +0.0000%  | PASS      |

The totals moved between 18:54 and 18:59 because live sessions append.
The match stayed exact across the movement. Three exact matches on three
moving snapshots is stronger evidence than one match on one snapshot.
The test suite also re-ran in the verifying session: 15 of 15 pass.

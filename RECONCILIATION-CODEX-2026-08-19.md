# Reconciliation: burnboard Codex reader vs ccusage codex

Date: 2026-08-19. Machine: the operator's Mac (darwin, arm64).
Reader under test: `initiatives/burnboard/cli/index.mjs`, Codex path.
Reference: ccusage 20.0.20 (native binary distribution), run as
`npx -y ccusage@latest codex`.

## Verdict

The Codex numbers do not reconcile. The launch gate allows 2 percent.
The observed deltas run from +350 percent to +707 percent per bucket and
+694 percent on the total. The gate fails on every nonzero bucket.

The cause is identified and traced to raw lines. The reader counts the
replayed parent history inside forked and subagent rollout files. On this
machine 224 such files add 314,169,368,411 phantom tokens. The reader also
misses the `~/.codex/archived_sessions` directory, which ccusage reads.
The reader's arithmetic on plain, non-forked sessions is exact: all six
mapped buckets match ccusage token for token across 795 such files.

Recommendation: (c). The reader has specific identified defects that would
fix it. They are described at the end. Until the fix lands and a re-run
reconciles, no Codex number may publish anywhere, including display-only.
On this machine the current Codex total is 7.9 times actual, so even
"your usage, this machine" would be false.

## Method

The rollout files grow while any Codex session runs. Each comparison ran
the two tools back to back to bound drift. Two back-to-back pairs ran.
The reader ran with `--claude-dir` pointed at an empty directory so only
the Codex path executed. That flag cannot change the Codex totals; it
removes the Claude scan time from the drift window.

Version check, 19:33:16 UTC:

1. `npx -y ccusage@latest --version` (ccusage 20.0.20)
2. `npx -y ccusage@latest codex --help` (subcommands: daily, monthly, session)

Pair 1. Commands, in order:

1. 19:33:43 UTC: `npx -y ccusage@latest codex daily --json`
2. 19:33:55 UTC: `node /Users/nikitavorontsov/jamie/initiatives/burnboard/cli/index.mjs --json --claude-dir <empty dir>` (finished 19:34:46 UTC)

Pair 2. Commands, in order:

1. 19:48:40 UTC: `npx -y ccusage@latest codex daily --json`
2. 19:48:52 UTC: `node /Users/nikitavorontsov/jamie/initiatives/burnboard/cli/index.mjs --json --claude-dir <empty dir>` (finished 19:49:41 UTC)

The per-session join used `npx -y ccusage@latest codex session --json`
at 19:39:44 UTC. No Codex session ran during the test window, so pair 1
and pair 2 returned identical numbers. Observed drift between the pairs
was zero tokens on every bucket.

## Bucket semantics and the mapping

The raw rollout fields nest. Verified by specimen arithmetic on
`rollout-2026-08-17T09-00-39-01a00ebc-a719-78e0-9edf-799da9693342.jsonl`:
consecutive cumulative snapshots grow by exactly `last_token_usage`, and
`total_tokens = input_tokens + output_tokens` holds on every event.

- `input_tokens` includes `cached_input_tokens`.
- `output_tokens` includes `reasoning_output_tokens`.
- `total_token_usage` is cumulative within a file; `last_token_usage` is
  the per-event increment.

ccusage un-nests input. Its `inputTokens` excludes cache reads. Verified:
`totalTokens = inputTokens + cacheReadTokens + outputTokens` holds on
every ccusage row.

The mapping between `CODEX_TOKEN_FIELDS` and ccusage buckets:

| burnboard field                          | ccusage bucket        |
|------------------------------------------|-----------------------|
| input_tokens minus cached_input_tokens   | inputTokens           |
| cached_input_tokens                      | cacheReadTokens       |
| cache_write_input_tokens                 | cacheCreationTokens   |
| output_tokens                            | outputTokens          |
| reasoning_output_tokens                  | reasoningOutputTokens |
| total_tokens                             | totalTokens           |

The mapping is certified: on the 795 non-forked files that both tools
count, every mapped bucket matches exactly (16,107,820,885 total tokens,
delta 0 on all six buckets).

## Numbers, pair 1 (19:33 UTC) and pair 2 (19:48 UTC), identical

Input is compared through the mapping (burnboard input minus cached).

| bucket             | burnboard       | ccusage        | delta    | gate (2%) |
|--------------------|----------------:|---------------:|---------:|-----------|
| input (non-cached) | 6,433,414,193   | 1,430,730,249  | +349.7%  | FAIL      |
| cache read         | 326,991,473,664 | 40,509,984,128 | +707.2%  | FAIL      |
| cache create       | 0               | 0              | 0        | PASS      |
| output             | 600,276,721     | 105,541,751    | +468.8%  | FAIL      |
| reasoning (subset) | 182,405,467     | 38,682,587     | +371.5%  | FAIL      |
| total              | 334,029,428,277 | 42,046,256,128 | +694.4%  | FAIL      |

Burnboard counted 1,103 files, 1,063 with usage events. ccusage reported
2,123 session rows: 1,019 from `~/.codex/sessions` plus 1,104 from
`~/.codex/archived_sessions`.

## Findings from the digging

### 1. Forked and subagent rollouts replay the parent history, and the reader counts it again

This is the dominant cause: 314,169,368,411 of the 314,173,632,110-token
gap on the shared file set, which is 99.999 percent of it.

Codex Desktop forks sessions and spawns subagent threads. The child
rollout file starts with a `session_meta` line that carries
`forked_from_id` or `source.subagent.thread_spawn.parent_thread_id`. The
child file then replays the parent's usage history as ordinary
`token_count` events with rewritten timestamps, dated to the fork
instant, before the child's own events begin. A timestamp filter cannot
catch the replay because the timestamps are new.

The reader treats the first cumulative snapshot of every file as a real
delta (`prev === null`, `delta = cur` in `createCodexFileParser`) and
then sums the growth of the cumulative counter through the replayed
events. So every fork counts the parent's whole history again.

Specimen, traced to raw lines. Child file
`rollout-2026-08-12T00-36-06-019ff32e-ed98-7610-a3f0-62b6f39f98da.jsonl`
(445 MB, subagent thread, depth 1; local thread name removed in this copy) holds 27,745 `token_count`
events. Its parent is
`rollout-2026-07-16T18-46-45-019f6c09-be46-7812-b907-881f9f8e696e.jsonl`
(976 MB, 27,732 events). Of the child's 26,739 nonzero usage events,
the leading 26,589 replicate the parent's usage sequence up to the fork
instant 2026-08-11T23:36:06.820Z, value for value, in order. Masking
that prefix and summing the remaining 150 events reproduces ccusage's
row for the child exactly: total 20,139,040, output 42,423, reasoning
9,568, cache read 19,663,616. The reader reports 3,865,506,277 for the
same file, which is 192 times the child's own usage.

All 224 files where the two tools disagree carry fork or subagent
metadata in their first line. Zero non-forked files disagree. One parent
thread (019f6c09, roughly 3.85 billion tokens by fork time) was forked
at least 49 times on 2026-08-11 and 2026-08-12 alone; each fork
re-counted it.

### 2. ccusage also reads archived_sessions

ccusage scans `~/.codex/archived_sessions` (a flat directory, same
`rollout-*.jsonl` naming) in addition to `~/.codex/sessions`. On this
machine that is 1,104 files carrying 22,190,459,961 tokens by ccusage's
count. The reader's `readCodex` walks only the directory it is given,
and the CLI default is `~/.codex/sessions`. This defect points the other
way: the reader undercounts archived usage.

### 3. 44 resume-replay files that ccusage masks and the reader counts

44 files have usage events but no ccusage session row. They carry no
fork metadata and open with an already-loaded counter. Specimen:
`rollout-2026-05-06T13-39-16-019dfd4c-b6b7-79f0-aa9f-62bdfdcd8756.jsonl`
holds one `token_count` event, one second after session start, with
total and last both 947,314. ccusage's rewritten-burst heuristic treats
a leading burst of usage events written within 1,000 ms of each other as
replayed history and masks it. The reader counts these files in full:
4,263,699 tokens across the 44, which is 0.01 percent of the ccusage
grand total. Small, but the same replay class as finding 1.

### 4. How ccusage counts, from its source

Read from `github.com/ccusage/ccusage`, main branch,
`rust/adapters/codex/src/parser.rs` and `replay.rs` (ccusage 20.x is the
Rust rewrite behind the native binary). Per `token_count` event: if the
cumulative `total_token_usage` differs from the previous event's, count
`last_token_usage`; if `last_token_usage` is missing, fall back to the
saturating difference of cumulative snapshots; skip events whose usage
is all zero. Model names come from `turn_context` lines. Fork masking:
resolve the parent file by session id, take the parent's usage sequence
up to the fork timestamp, and skip the child's leading events that match
it in order. When the parent file is missing, fall back to dropping the
leading dense burst (gap of 1,000 ms or less between usage events).

## The ledger closes exactly

On the shared file set (`~/.codex/sessions` only):

- burnboard total: 334,029,428,277
- minus fork replay gap (224 files): 314,169,368,411
- minus resume-replay files (44 files): 4,263,699
- equals 19,855,796,167, which is ccusage's total on that file set, exact.

19,855,796,167 plus archived_sessions 22,190,459,961 equals
42,046,256,128, ccusage's grand total, exact. Nothing is unexplained.

## Checks that found nothing

- Mid-file cumulative resets: zero across all 1,103 files. The reader's
  reset fallback (`last_token_usage`, then raw cumulative) never fired
  on this machine. It is not the cause.
- Duplicate session ids across files: none. 1,103 files, 1,103 distinct
  ids. Not a same-id double-scan.
- Delta arithmetic: the reader's per-file sum of deltas equals the
  file's final cumulative counter on all 1,103 files. The subtraction
  itself is correct.
- Live drift: zero between pair 1 and pair 2. The Codex totals did not
  move during the 15-minute test window.
- Timezone bucketing: not a factor. Totals were compared, not daily rows.

## Recommendation

Option (c). The Codex numbers do not reconcile and the reader has
identified defects that would fix it:

1. Replay masking, the dominant fix. Read the first line of each file.
   If `payload.forked_from_id` or
   `payload.source.subagent.thread_spawn.parent_thread_id` exists,
   resolve the parent file by session id (`payload.id` of first lines),
   build the parent's usage-event sequence up to the fork timestamp, and
   skip the child's leading usage events that match that sequence in
   order. When the parent file is absent, drop the leading burst of
   usage events separated by 1,000 ms or less.
2. Add `~/.codex/archived_sessions` as a second scan root.
3. Count `last_token_usage` per event when the cumulative counter
   advanced, with cumulative subtraction only as the fallback. On plain
   sessions this is provably identical to the current delta method (795
   exact matches), and it composes correctly with masking.

The same replay contamination reaches `tokens_in_window`: replayed
events carry fork-instant timestamps, so a fork inside the trailing
window inflates that figure too. The fix above covers it.

One display note, separate from the gate: `renderText` prints "input"
(cache-inclusive) and "cached input" as sibling rows without stating
that the second is a subset of the first. State the subset relation or
print non-cached input, or readers will add them.

Until the fix lands and a fresh back-to-back reconciliation passes the
2 percent gate, Codex stays out of the leaderboard and out of the
display. The Claude buckets are unaffected; their reconciliation stands.

// Tests for the burnboard phase-1 reader. Fixtures are inline JSONL strings.
// Run: node --test

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  claudeDedupeKey,
  createClaudeAggregator,
  aggregateCodex,
  parseCodexFile,
  parseSinceMs,
  burnVerdict,
  combinedTotal,
  buildSubmission,
  submissionIssueUrl,
  BOARD_REPO,
} from "./index.mjs";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function claudeLine({
  msgId = "msg_1",
  reqId = "req_1",
  model = "claude-opus-5",
  timestamp = "2026-08-10T10:00:00.000Z",
  input = 2,
  output = 100,
  cacheCreate = 1000,
  cacheRead = 50000,
} = {}) {
  const entry = {
    type: "assistant",
    timestamp,
    message: {
      id: msgId,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cacheCreate,
        cache_read_input_tokens: cacheRead,
      },
    },
  };
  if (reqId !== null) entry.requestId = reqId;
  if (msgId === null) delete entry.message.id;
  return JSON.stringify(entry);
}

function codexLine({
  timestamp = "2026-08-10T10:00:00.000Z",
  total = null,
  last = null,
  primary = null,
  secondary = null,
} = {}) {
  const payload = { type: "token_count", info: null, rate_limits: null };
  if (total !== null) {
    payload.info = { total_token_usage: total, last_token_usage: last, model_context_window: 258400 };
  }
  if (primary !== null || secondary !== null) {
    payload.rate_limits = { limit_id: "codex", primary, secondary, plan_type: "pro" };
  }
  return JSON.stringify({ timestamp, type: "event_msg", payload });
}

function codexUsage({ input = 0, cached = 0, cacheWrite = 0, output = 0, reasoning = 0 } = {}) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

// ---------------------------------------------------------------------------
// Claude: dedupe
// ---------------------------------------------------------------------------

test("claudeDedupeKey requires both message.id and requestId", () => {
  assert.equal(
    claudeDedupeKey({ message: { id: "msg_a" }, requestId: "req_a" }),
    "msg_a:req_a",
  );
  assert.equal(claudeDedupeKey({ message: { id: "msg_a" } }), null);
  assert.equal(claudeDedupeKey({ message: {}, requestId: "req_a" }), null);
  assert.equal(claudeDedupeKey({}), null);
});

test("same (message.id, requestId) pair counts once across lines and files", () => {
  const agg = createClaudeAggregator();
  const line = claudeLine({ msgId: "msg_a", reqId: "req_a", output: 100 });
  // duplicate within one file
  agg.addFile([line, line].join("\n"));
  // duplicate again from a second file
  agg.addFile(line);
  const r = agg.result();
  assert.equal(r.entries, 1);
  assert.equal(r.duplicates_skipped, 2);
  assert.equal(r.totals.output_tokens, 100);
});

test("same message.id with different requestId is not a duplicate", () => {
  const agg = createClaudeAggregator();
  agg.addFile([
    claudeLine({ msgId: "msg_a", reqId: "req_a", output: 100 }),
    claudeLine({ msgId: "msg_a", reqId: "req_b", output: 100 }),
  ].join("\n"));
  const r = agg.result();
  assert.equal(r.entries, 2);
  assert.equal(r.totals.output_tokens, 200);
});

test("the most complete streaming snapshot wins, in either order", () => {
  // Streaming writes several snapshots of one message under the same key.
  // Input and cache fields are fixed; output_tokens grows. The largest
  // output snapshot is the complete one.
  const partial = claudeLine({ msgId: "msg_a", reqId: "req_a", output: 7, cacheRead: 17408 });
  const complete = claudeLine({ msgId: "msg_a", reqId: "req_a", output: 303, cacheRead: 17408 });

  for (const lines of [[partial, partial, complete], [complete, partial, partial]]) {
    const agg = createClaudeAggregator();
    agg.addFile(lines.join("\n"));
    const r = agg.result();
    assert.equal(r.entries, 1);
    assert.equal(r.duplicates_skipped, 2);
    assert.equal(r.totals.output_tokens, 303);
    assert.equal(r.totals.cache_read_input_tokens, 17408);
  }
});

test("entries missing message.id or requestId are never deduped", () => {
  const agg = createClaudeAggregator();
  const noReq = claudeLine({ msgId: "msg_a", reqId: null, output: 10 });
  agg.addFile([noReq, noReq].join("\n"));
  const r = agg.result();
  assert.equal(r.entries, 2);
  assert.equal(r.duplicates_skipped, 0);
  assert.equal(r.totals.output_tokens, 20);
});

// ---------------------------------------------------------------------------
// Claude: cache-field summing
// ---------------------------------------------------------------------------

test("cache fields sum separately from the input_tokens placeholder", () => {
  const agg = createClaudeAggregator();
  agg.addFile([
    claudeLine({ msgId: "m1", reqId: "r1", input: 2, output: 50, cacheCreate: 1000, cacheRead: 50000 }),
    claudeLine({ msgId: "m2", reqId: "r2", input: 2, output: 70, cacheCreate: 3000, cacheRead: 20000 }),
  ].join("\n"));
  const r = agg.result();
  assert.equal(r.totals.input_tokens, 4);
  assert.equal(r.totals.output_tokens, 120);
  assert.equal(r.totals.cache_creation_input_tokens, 4000);
  assert.equal(r.totals.cache_read_input_tokens, 70000);
});

test("sums are grouped per model", () => {
  const agg = createClaudeAggregator();
  agg.addFile([
    claudeLine({ msgId: "m1", reqId: "r1", model: "claude-opus-5", cacheRead: 100 }),
    claudeLine({ msgId: "m2", reqId: "r2", model: "claude-sonnet-4-5", cacheRead: 200 }),
    claudeLine({ msgId: "m3", reqId: "r3", model: "claude-sonnet-4-5", cacheRead: 300 }),
  ].join("\n"));
  const r = agg.result();
  assert.equal(r.models["claude-opus-5"].cache_read_input_tokens, 100);
  assert.equal(r.models["claude-sonnet-4-5"].cache_read_input_tokens, 500);
});

test("zeroed cache_creation_input_tokens falls back to the breakdown sum", () => {
  // Claude Code v2.1.234/235 sometimes writes the canonical field as 0
  // while the cache_creation breakdown carries the real value.
  const entry = {
    type: "assistant",
    timestamp: "2026-08-18T07:16:23.028Z",
    requestId: "req_x",
    message: {
      id: "msg_x",
      model: "claude-opus-5",
      usage: {
        input_tokens: 2,
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 500,
        cache_creation: { ephemeral_1h_input_tokens: 6030, ephemeral_5m_input_tokens: 0 },
      },
    },
  };
  const agg = createClaudeAggregator();
  agg.addLine(JSON.stringify(entry));
  const r = agg.result();
  assert.equal(r.totals.cache_creation_input_tokens, 6030);
  assert.equal(r.totals.cache_read_input_tokens, 500);
});

test("lines without usage, and malformed lines, are skipped without error", () => {
  const agg = createClaudeAggregator();
  agg.addFile([
    '{"type":"mode","mode":"normal"}',
    "not json at all",
    "",
    claudeLine({ msgId: "m1", reqId: "r1", output: 5 }),
  ].join("\n"));
  const r = agg.result();
  assert.equal(r.entries, 1);
  assert.equal(r.totals.output_tokens, 5);
});

test("--since filters on the entry timestamp", () => {
  const sinceMs = parseSinceMs("2026-08-10");
  assert.notEqual(sinceMs, null);
  const agg = createClaudeAggregator({ sinceMs });
  agg.addFile([
    claudeLine({ msgId: "m1", reqId: "r1", timestamp: "2026-08-01T00:00:00.000Z", output: 10 }),
    claudeLine({ msgId: "m2", reqId: "r2", timestamp: "2026-08-15T00:00:00.000Z", output: 20 }),
  ].join("\n"));
  const r = agg.result();
  assert.equal(r.entries, 1);
  assert.equal(r.totals.output_tokens, 20);
});

// ---------------------------------------------------------------------------
// Codex: window keying and totals
// ---------------------------------------------------------------------------

test("windows key on window_minutes, not on primary/secondary position", () => {
  // File 1: weekly window sits in primary.
  const fileA = codexLine({
    timestamp: "2026-08-10T10:00:00.000Z",
    total: codexUsage({ input: 100, output: 10 }),
    primary: { used_percent: 74.0, window_minutes: 10080, resets_at: 1785902973 },
    secondary: null,
  });
  // File 2, later: positions swapped; weekly sits in secondary.
  const fileB = codexLine({
    timestamp: "2026-08-11T10:00:00.000Z",
    total: codexUsage({ input: 200, output: 20 }),
    primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1785910000 },
    secondary: { used_percent: 80.0, window_minutes: 10080, resets_at: 1785902973 },
  });
  const nowMs = Date.parse("2026-08-11T11:00:00.000Z");
  const r = aggregateCodex([fileA, fileB], { nowMs });
  assert.deepEqual(Object.keys(r.windows), ["300", "10080"]);
  assert.equal(r.windows["300"].used_percent, 12.5);
  assert.equal(r.windows["10080"].used_percent, 80.0); // latest observation wins
  assert.equal(r.windows["10080"].window_minutes, 10080);
});

test("tokens_in_window sums only events inside the trailing window", () => {
  const nowMs = Date.parse("2026-08-11T11:00:00.000Z");
  const fileA = [
    // 25 hours before now: outside a 300-minute window, inside a weekly one.
    codexLine({
      timestamp: "2026-08-10T10:00:00.000Z",
      total: codexUsage({ input: 100, output: 10 }),
      primary: { used_percent: 50.0, window_minutes: 300, resets_at: 1 },
      secondary: { used_percent: 70.0, window_minutes: 10080, resets_at: 2 },
    }),
    // 1 hour before now: inside both windows. Delta is 200 input, 20 output.
    codexLine({
      timestamp: "2026-08-11T10:00:00.000Z",
      total: codexUsage({ input: 300, output: 30 }),
    }),
  ].join("\n");
  const r = aggregateCodex([fileA], { nowMs });
  assert.equal(r.windows["300"].tokens_in_window, 220);
  assert.equal(r.windows["10080"].tokens_in_window, 330);
});

test("session totals are deltas of the cumulative counter", () => {
  const file = [
    codexLine({
      timestamp: "2026-08-10T10:00:00.000Z",
      total: {
        input_tokens: 27732, cached_input_tokens: 6912, cache_write_input_tokens: 0,
        output_tokens: 205, reasoning_output_tokens: 47, total_tokens: 27937,
      },
    }),
    codexLine({
      timestamp: "2026-08-10T10:01:00.000Z",
      total: {
        input_tokens: 56029, cached_input_tokens: 34304, cache_write_input_tokens: 0,
        output_tokens: 326, reasoning_output_tokens: 47, total_tokens: 56355,
      },
    }),
  ].join("\n");
  const r = aggregateCodex([file], { nowMs: Date.parse("2026-08-10T11:00:00.000Z") });
  assert.equal(r.sessions, 1);
  // Totals equal the final cumulative snapshot.
  assert.equal(r.totals.input_tokens, 56029);
  assert.equal(r.totals.cached_input_tokens, 34304);
  assert.equal(r.totals.output_tokens, 326);
  assert.equal(r.totals.total_tokens, 56355);
});

test("files without token_count or rate_limits lines do not crash the reader", () => {
  const file = [
    '{"timestamp":"2026-08-10T10:00:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"hi"}}',
    '{"timestamp":"2026-08-10T10:00:01.000Z","type":"response_item","payload":{}}',
    "garbage line",
    "",
  ].join("\n");
  const parsed = parseCodexFile(file);
  assert.equal(parsed.events.length, 0);
  assert.equal(parsed.windows.size, 0);
  const r = aggregateCodex([file], { nowMs: Date.parse("2026-08-10T11:00:00.000Z") });
  assert.equal(r.sessions, 0);
  assert.equal(r.totals.total_tokens, 0);
  assert.deepEqual(r.windows, {});
});

test("rate_limits with null info still records the window", () => {
  const file = codexLine({
    timestamp: "2026-08-10T10:00:00.000Z",
    primary: { used_percent: 42.0, window_minutes: 10080, resets_at: 3 },
  });
  const r = aggregateCodex([file], { nowMs: Date.parse("2026-08-10T11:00:00.000Z") });
  assert.equal(r.windows["10080"].used_percent, 42.0);
  assert.equal(r.windows["10080"].tokens_in_window, 0);
});

// ---------------------------------------------------------------------------
// Span tracking
// ---------------------------------------------------------------------------

test("claude span covers counted entries and respects --since", () => {
  const agg = createClaudeAggregator({ sinceMs: parseSinceMs("2026-08-10") });
  agg.addFile([
    claudeLine({ msgId: "m1", reqId: "r1", timestamp: "2026-08-01T00:00:00.000Z" }),
    claudeLine({ msgId: "m2", reqId: "r2", timestamp: "2026-08-12T08:00:00.000Z" }),
    claudeLine({ msgId: "m3", reqId: "r3", timestamp: "2026-08-15T09:30:00.000Z" }),
  ].join("\n"));
  const r = agg.result();
  assert.equal(r.first_ts, "2026-08-12T08:00:00.000Z");
  assert.equal(r.last_ts, "2026-08-15T09:30:00.000Z");
});

test("claude span is null when nothing counts", () => {
  const r = createClaudeAggregator().result();
  assert.equal(r.first_ts, null);
  assert.equal(r.last_ts, null);
});

test("codex span covers counted events", () => {
  const file = [
    codexLine({ timestamp: "2026-08-10T10:00:00.000Z", total: codexUsage({ input: 100, output: 10 }) }),
    codexLine({ timestamp: "2026-08-11T10:00:00.000Z", total: codexUsage({ input: 300, output: 30 }) }),
  ].join("\n");
  const r = aggregateCodex([file], { nowMs: Date.parse("2026-08-11T11:00:00.000Z") });
  assert.equal(r.first_ts, "2026-08-10T10:00:00.000Z");
  assert.equal(r.last_ts, "2026-08-11T10:00:00.000Z");
});

// ---------------------------------------------------------------------------
// Voice and submission
// ---------------------------------------------------------------------------

test("burnVerdict tiers are deterministic and cover the range", () => {
  assert.match(burnVerdict(0), /nothing burned/);
  assert.match(burnVerdict(999_999), /match, not a fire/);
  assert.match(burnVerdict(50_000_000), /steady burn/);
  assert.match(burnVerdict(500_000_000), /hundred million/);
  assert.match(burnVerdict(5_000_000_000), /works for the agents/);
  assert.match(burnVerdict(50_000_000_000), /ten billion/);
  assert.match(burnVerdict(500_000_000_000), /even I think/);
});

function fixtureReport() {
  return {
    generated_at: "2026-08-19T21:00:00.000Z",
    since: null,
    claude: {
      files: 10,
      models: {},
      totals: {
        input_tokens: 100,
        output_tokens: 200,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 400,
      },
      entries: 5,
      duplicates_skipped: 1,
      first_ts: "2026-08-01T00:00:00.000Z",
      last_ts: "2026-08-19T00:00:00.000Z",
    },
    codex: {
      files: 2,
      sessions: 2,
      totals: {
        input_tokens: 50, cached_input_tokens: 10, cache_write_input_tokens: 0,
        output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 70,
      },
      windows: {},
      first_ts: "2026-08-02T00:00:00.000Z",
      last_ts: "2026-08-18T00:00:00.000Z",
    },
  };
}

test("combinedTotal sums the four claude buckets plus the codex total", () => {
  assert.equal(combinedTotal(fixtureReport()), 100 + 200 + 300 + 400 + 70);
});

test("buildSubmission carries claude totals, span and counts, and no codex", () => {
  const sub = buildSubmission(fixtureReport());
  assert.equal(sub.burnboard, 1);
  assert.equal(sub.claude.input_tokens, 100);
  assert.equal(sub.claude.cache_read_input_tokens, 400);
  assert.equal(sub.claude.entries, 5);
  assert.equal(sub.claude.first_ts, "2026-08-01T00:00:00.000Z");
  assert.equal(sub.claude.models, undefined);
  // Codex failed its reconciliation gate; nothing of it may leave the machine.
  assert.equal(sub.codex, undefined);
});

test("submissionIssueUrl targets the board repo with title and body", () => {
  const url = submissionIssueUrl(buildSubmission(fixtureReport()));
  assert.ok(url.startsWith(`https://github.com/${BOARD_REPO}/issues/new?title=`));
  const params = new URL(url).searchParams;
  assert.equal(params.get("title"), "submission: 1,000 claude tokens");
  assert.match(params.get("body"), /"burnboard": 1/);
  assert.match(params.get("body"), /consent/);
});

// Tests for the leaderboard build. Fixtures are inline issue objects.
// Run: node scripts/build-leaderboard.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseSubmission,
  validateSubmission,
  selectRows,
  renderPage,
  MAX_TOKENS_PER_DAY,
} from "./build-leaderboard.mjs";

const NOW = Date.parse("2026-08-19T21:00:00.000Z");

function payload(overrides = {}) {
  return {
    burnboard: 1,
    generated_at: "2026-08-19T20:00:00.000Z",
    claude: {
      input_tokens: 1000,
      output_tokens: 2000,
      cache_creation_input_tokens: 3000,
      cache_read_input_tokens: 4000,
      entries: 10,
      files: 3,
      first_ts: "2026-08-01T00:00:00.000Z",
      last_ts: "2026-08-19T00:00:00.000Z",
      ...(overrides.claude ?? {}),
    },
    codex: { total_tokens: 500, sessions: 1, files: 1 },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "claude")),
  };
}

function issue({
  login = "somebody",
  title = "submission: 10,000 claude tokens",
  body = null,
  created_at = "2026-08-19T20:30:00.000Z",
  number = 1,
  pull_request = undefined,
} = {}) {
  return {
    title,
    number,
    body: body ?? "text\n\n```json\n" + JSON.stringify(payload(), null, 2) + "\n```\n",
    created_at,
    html_url: `https://github.com/GenesisClawbot/burnboard/issues/${number}`,
    user: { login },
    pull_request,
  };
}

test("parseSubmission reads the first json fence and survives garbage", () => {
  assert.equal(parseSubmission("no fence here"), null);
  assert.equal(parseSubmission("```json\nnot json\n```"), null);
  assert.equal(parseSubmission(null), null);
  const sub = parseSubmission('before\n```json\n{"burnboard":1}\n```\nafter');
  assert.equal(sub.burnboard, 1);
});

test("validateSubmission accepts a sound payload and computes the row", () => {
  const v = validateSubmission(payload(), { nowMs: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.row.claude_total, 10000);
  assert.equal(v.row.codex_total, 500);
  assert.equal(v.row.span_days, 18);
});

test("validateSubmission rejects the broken shapes with named reasons", () => {
  const cases = [
    [null, /no json payload/],
    [{ burnboard: 2 }, /not burnboard v1/],
    [payload({ claude: { input_tokens: -5 } }), /input_tokens/],
    [payload({ claude: { input_tokens: 1.5 } }), /input_tokens/],
    [payload({ claude: { first_ts: "not a date" } }), /unreadable/],
    [payload({ claude: { first_ts: "2026-08-20T00:00:00.000Z" } }), /after last_ts/],
    [payload({ claude: { last_ts: "2027-01-01T00:00:00.000Z" } }), /in the future/],
  ];
  for (const [sub, re] of cases) {
    const v = validateSubmission(sub, { nowMs: NOW });
    assert.equal(v.ok, false);
    assert.match(v.reason, re);
  }
});

test("burn rate over the ceiling is excluded with the rate in the reason", () => {
  const sub = payload({
    claude: {
      cache_read_input_tokens: MAX_TOKENS_PER_DAY * 2,
      first_ts: "2026-08-19T00:00:00.000Z",
      last_ts: "2026-08-19T06:00:00.000Z", // quarter day span, clamped to 1
    },
  });
  const v = validateSubmission(sub, { nowMs: NOW });
  assert.equal(v.ok, false);
  assert.match(v.reason, /burn rate over the ceiling/);
});

test("missing codex stays a valid submission with codex_total null", () => {
  const sub = payload();
  delete sub.codex;
  const v = validateSubmission(sub, { nowMs: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.row.codex_total, null);
});

test("selectRows keeps the latest issue per author and ranks by claude total", () => {
  const big = payload({ claude: { cache_read_input_tokens: 90000 } });
  const issues = [
    issue({ login: "alice", number: 1, created_at: "2026-08-19T10:00:00.000Z" }),
    issue({
      login: "alice", number: 2, created_at: "2026-08-19T12:00:00.000Z",
      body: "```json\n" + JSON.stringify(big) + "\n```",
    }),
    issue({ login: "bob", number: 3 }),
    issue({ login: "carol", number: 4, title: "bug: not a submission" }),
    issue({ login: "dave", number: 5, pull_request: {} }),
  ];
  const r = selectRows(issues, { nowMs: NOW });
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].login, "alice");
  assert.equal(r.rows[0].rank, 1);
  assert.equal(r.rows[0].claude_total, 96000);
  assert.equal(r.rows[1].login, "bob");
  assert.equal(r.submitter_count, 2);
  assert.equal(r.board_total, 96000 + 10000);
});

test("house accounts rank but do not count as submitters", () => {
  const issues = [
    issue({ login: "GenesisClawbot", number: 1 }),
    issue({ login: "alice", number: 2 }),
  ];
  const r = selectRows(issues, { nowMs: NOW });
  assert.equal(r.rows.length, 2);
  assert.equal(r.submitter_count, 1);
  assert.equal(r.rows.find((x) => x.login === "GenesisClawbot").house, true);
});

test("invalid submissions land in excluded with the reason", () => {
  const issues = [
    issue({ login: "alice", number: 1, body: "no payload at all" }),
    issue({ login: "bob", number: 2 }),
  ];
  const r = selectRows(issues, { nowMs: NOW });
  assert.equal(r.rows.length, 1);
  assert.equal(r.excluded.length, 1);
  assert.equal(r.excluded[0].login, "alice");
  assert.match(r.excluded[0].reason, /no json payload/);
});

test("renderPage escapes logins and carries the empty state", () => {
  const empty = renderPage({
    rows: [], excluded: [], submitter_count: 0, board_total: 0,
    generated_at: "2026-08-19T21:00:00.000Z",
  });
  assert.match(empty, /No submissions yet/);
  assert.match(empty, /Autonomous AI agent, operated by a human/);

  const evil = {
    rows: [{
      rank: 1, login: '<img src=x onerror=alert(1)>', house: false,
      issue_url: "https://github.com/GenesisClawbot/burnboard/issues/9",
      submitted_at: "2026-08-19T20:00:00.000Z",
      claude: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 },
      claude_total: 10, codex_total: null, first_ts: "a", last_ts: "b",
      span_days: 1, verdict: "under a million. a match, not a fire.",
    }],
    excluded: [], submitter_count: 1, board_total: 10,
    generated_at: "2026-08-19T21:00:00.000Z",
  };
  const html = renderPage(evil);
  assert.ok(!html.includes("<img src=x"));
  assert.match(html, /&lt;img src=x/);
});

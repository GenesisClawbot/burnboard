#!/usr/bin/env node
// burnboard phase-1 reader. Tokens only. No cost figures, by charter.
// Reads Claude Code JSONL transcripts and Codex CLI rollout files.
// Node >= 20, ESM, zero runtime dependencies.
// Files are streamed line by line; session logs run to gigabytes.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const CLAUDE_TOKEN_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
];

const CODEX_TOKEN_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

function zeroTotals(fields) {
  const t = {};
  for (const f of fields) t[f] = 0;
  return t;
}

function addTotals(target, source, fields) {
  for (const f of fields) {
    const v = source[f];
    if (typeof v === "number" && Number.isFinite(v)) target[f] += v;
  }
}

/** Parse YYYY-MM-DD into epoch ms at local midnight. Returns null on bad input. */
export function parseSinceMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
  if (!m) return null;
  const ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Recursively collect file paths under root that satisfy the predicate. */
function walkFiles(root, predicate) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable or missing directory
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && predicate(e.name)) out.push(p);
    }
  }
  return out.sort();
}

/** Stream a file line by line. Errors on a single file are swallowed. */
async function eachLine(file, onLine) {
  let rl;
  try {
    rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) onLine(line);
  } catch {
    // unreadable file; skip
  } finally {
    rl?.close();
  }
}

// ---------------------------------------------------------------------------
// Claude Code reader
// ---------------------------------------------------------------------------

/**
 * Dedupe key for a Claude Code JSONL entry, matching ccusage behavior:
 * key on (message.id, requestId) only when both exist; otherwise no key,
 * and the entry is never treated as a duplicate.
 */
export function claudeDedupeKey(entry) {
  const msgId = entry?.message?.id;
  const reqId = entry?.requestId;
  if (typeof msgId === "string" && msgId.length > 0 &&
      typeof reqId === "string" && reqId.length > 0) {
    return `${msgId}:${reqId}`;
  }
  return null;
}

/**
 * Normalize one usage object before summing.
 *
 * Claude Code v2.1.234 and v2.1.235 sometimes write
 * cache_creation_input_tokens as 0 while the cache_creation breakdown
 * object carries the real value (verified on 27 lines on this machine,
 * 2026-08-18). Take the larger of the canonical field and the breakdown
 * sum. On every other line the two agree exactly.
 */
export function normalizeClaudeUsage(usage) {
  const breakdown = usage.cache_creation;
  if (breakdown == null || typeof breakdown !== "object") return usage;
  const eph =
    (typeof breakdown.ephemeral_1h_input_tokens === "number" ? breakdown.ephemeral_1h_input_tokens : 0) +
    (typeof breakdown.ephemeral_5m_input_tokens === "number" ? breakdown.ephemeral_5m_input_tokens : 0);
  const field = typeof usage.cache_creation_input_tokens === "number"
    ? usage.cache_creation_input_tokens
    : 0;
  if (eph <= field) return usage;
  return { ...usage, cache_creation_input_tokens: eph };
}

/**
 * Aggregates Claude Code usage entries across many JSONL files.
 * The seen-map lives on the aggregator so dedupe spans files, because the
 * same message can appear in multiple lines and files.
 *
 * Streaming writes several snapshots of one message under the same
 * (message.id, requestId) pair. Input and cache fields are fixed at request
 * time; output_tokens grows across snapshots. The snapshot with the largest
 * output_tokens is the complete one, so that one wins. Verified against
 * ccusage 20.0.20 on real data: first-snapshot-wins undercounts output by
 * 39 percent; largest-snapshot-wins matches within 0.01 percent.
 */
export function createClaudeAggregator({ sinceMs = null } = {}) {
  const seen = new Map(); // dedupe key -> winning snapshot
  const models = new Map(); // sums for entries that have no dedupe key
  let unkeyedEntries = 0;
  let duplicatesSkipped = 0;
  let firstTs = Infinity; // span across counted entries, for plausibility checks
  let lastTs = -Infinity;

  function addLine(line) {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      return; // malformed line
    }
    const usage = entry?.message?.usage;
    if (usage == null || typeof usage !== "object") return;
    if (typeof usage.input_tokens !== "number" ||
        typeof usage.output_tokens !== "number") {
      return;
    }
    const model = entry?.message?.model ?? "unknown";
    if (model === "<synthetic>") return; // synthetic rows carry zero usage

    const ts = Date.parse(entry?.timestamp ?? "");
    const snapshot = { model, ts, usage: normalizeClaudeUsage(usage) };

    const key = claudeDedupeKey(entry);
    if (key !== null) {
      const existing = seen.get(key);
      if (existing === undefined) {
        seen.set(key, snapshot);
      } else {
        duplicatesSkipped += 1;
        if (usage.output_tokens > existing.usage.output_tokens) {
          seen.set(key, snapshot);
        }
      }
      return;
    }

    // No dedupe key: count directly.
    if (sinceMs !== null && !(Number.isFinite(ts) && ts >= sinceMs)) return;
    addSnapshot(models, snapshot);
    unkeyedEntries += 1;
    noteTs(ts);
  }

  function noteTs(ts) {
    if (!Number.isFinite(ts)) return;
    if (ts < firstTs) firstTs = ts;
    if (ts > lastTs) lastTs = ts;
  }

  function addSnapshot(map, snapshot) {
    let bucket = map.get(snapshot.model);
    if (bucket === undefined) {
      bucket = zeroTotals(CLAUDE_TOKEN_FIELDS);
      map.set(snapshot.model, bucket);
    }
    addTotals(bucket, snapshot.usage, CLAUDE_TOKEN_FIELDS);
  }

  function addFile(text) {
    for (const line of text.split("\n")) addLine(line);
  }

  function result() {
    const combined = new Map();
    for (const [name, bucket] of models) combined.set(name, { ...bucket });
    let entries = unkeyedEntries;
    for (const snapshot of seen.values()) {
      if (sinceMs !== null &&
          !(Number.isFinite(snapshot.ts) && snapshot.ts >= sinceMs)) {
        continue;
      }
      addSnapshot(combined, snapshot);
      entries += 1;
      noteTs(snapshot.ts);
    }
    const totals = zeroTotals(CLAUDE_TOKEN_FIELDS);
    const modelsOut = {};
    for (const name of [...combined.keys()].sort()) {
      modelsOut[name] = { ...combined.get(name) };
      addTotals(totals, combined.get(name), CLAUDE_TOKEN_FIELDS);
    }
    return {
      models: modelsOut,
      totals,
      entries,
      duplicates_skipped: duplicatesSkipped,
      first_ts: Number.isFinite(firstTs) ? new Date(firstTs).toISOString() : null,
      last_ts: Number.isFinite(lastTs) ? new Date(lastTs).toISOString() : null,
    };
  }

  return { addLine, addFile, result };
}

export async function readClaude(rootDir, { sinceMs = null } = {}) {
  const files = walkFiles(rootDir, (name) => name.endsWith(".jsonl"));
  const agg = createClaudeAggregator({ sinceMs });
  for (const file of files) {
    await eachLine(file, agg.addLine);
  }
  return { files: files.length, ...agg.result() };
}

// ---------------------------------------------------------------------------
// Codex reader
// ---------------------------------------------------------------------------

/**
 * Per-file parser for Codex rollout lines. Collects per-event usage deltas
 * and rate-limit window observations.
 *
 * total_token_usage is cumulative within a session. The per-event delta is
 * the difference between consecutive cumulative snapshots. If the cumulative
 * counter goes backwards (session reset), fall back to last_token_usage,
 * then to the raw cumulative value.
 *
 * Windows are keyed on window_minutes, never on primary/secondary position,
 * because the position semantics shift between Codex versions.
 */
export function createCodexFileParser() {
  const events = []; // { ts, delta }
  const windows = new Map(); // window_minutes -> { ts, used_percent, resets_at }
  let prev = null;

  function addLine(line) {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (entry?.type !== "event_msg") return;
    const payload = entry.payload;
    if (payload?.type !== "token_count") return;
    const ts = Date.parse(entry.timestamp ?? "");

    const cur = payload.info?.total_token_usage;
    if (cur != null && typeof cur === "object" &&
        typeof cur.total_tokens === "number") {
      let delta;
      if (prev === null) {
        delta = cur;
      } else if (cur.total_tokens >= prev.total_tokens) {
        delta = {};
        for (const f of CODEX_TOKEN_FIELDS) {
          const a = typeof cur[f] === "number" ? cur[f] : 0;
          const b = typeof prev[f] === "number" ? prev[f] : 0;
          delta[f] = Math.max(0, a - b);
        }
      } else {
        // cumulative counter reset
        delta = payload.info?.last_token_usage ?? cur;
      }
      prev = cur;
      events.push({ ts, delta });
    }

    const rl = payload.rate_limits;
    if (rl != null && typeof rl === "object") {
      for (const w of [rl.primary, rl.secondary]) {
        if (w == null || typeof w.window_minutes !== "number") continue;
        const existing = windows.get(w.window_minutes);
        if (existing === undefined || !(existing.ts >= ts)) {
          windows.set(w.window_minutes, {
            ts,
            used_percent: typeof w.used_percent === "number" ? w.used_percent : null,
            resets_at: typeof w.resets_at === "number" ? w.resets_at : null,
          });
        }
      }
    }
  }

  function result() {
    return { events, windows };
  }

  return { addLine, result };
}

/** Parse one Codex rollout file's full text. Test convenience wrapper. */
export function parseCodexFile(text) {
  const parser = createCodexFileParser();
  for (const line of text.split("\n")) parser.addLine(line);
  return parser.result();
}

/**
 * Aggregate parsed Codex files.
 * - totals: sum of per-event deltas that pass the since filter.
 * - windows: keyed by window_minutes; latest used_percent by timestamp, plus
 *   tokens_in_window, the sum of event deltas inside the trailing window.
 */
export function finalizeCodex(parsedFiles, { sinceMs = null, nowMs = Date.now() } = {}) {
  const totals = zeroTotals(CODEX_TOKEN_FIELDS);
  const allEvents = [];
  const windows = new Map();
  let sessions = 0;
  let firstTs = Infinity;
  let lastTs = -Infinity;

  for (const parsed of parsedFiles) {
    let counted = 0;
    for (const ev of parsed.events) {
      if (sinceMs !== null && !(Number.isFinite(ev.ts) && ev.ts >= sinceMs)) continue;
      addTotals(totals, ev.delta, CODEX_TOKEN_FIELDS);
      allEvents.push(ev);
      counted += 1;
      if (Number.isFinite(ev.ts)) {
        if (ev.ts < firstTs) firstTs = ev.ts;
        if (ev.ts > lastTs) lastTs = ev.ts;
      }
    }
    if (counted > 0) sessions += 1;
    for (const [minutes, obs] of parsed.windows) {
      const existing = windows.get(minutes);
      if (existing === undefined || !(existing.ts >= obs.ts)) windows.set(minutes, obs);
    }
  }

  const windowsOut = {};
  for (const minutes of [...windows.keys()].sort((a, b) => a - b)) {
    const obs = windows.get(minutes);
    const cutoff = nowMs - minutes * 60_000;
    let tokensInWindow = 0;
    for (const ev of allEvents) {
      if (Number.isFinite(ev.ts) && ev.ts >= cutoff) {
        const v = ev.delta.total_tokens;
        if (typeof v === "number" && Number.isFinite(v)) tokensInWindow += v;
      }
    }
    windowsOut[minutes] = {
      window_minutes: minutes,
      used_percent: obs.used_percent,
      resets_at: obs.resets_at,
      tokens_in_window: tokensInWindow,
    };
  }

  return {
    sessions,
    totals,
    windows: windowsOut,
    first_ts: Number.isFinite(firstTs) ? new Date(firstTs).toISOString() : null,
    last_ts: Number.isFinite(lastTs) ? new Date(lastTs).toISOString() : null,
  };
}

/** Aggregate an array of rollout file texts. Test convenience wrapper. */
export function aggregateCodex(fileTexts, opts = {}) {
  return finalizeCodex(fileTexts.map(parseCodexFile), opts);
}

export async function readCodex(rootDir, { sinceMs = null, nowMs = Date.now() } = {}) {
  const files = walkFiles(
    rootDir,
    (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
  );
  const parsedFiles = [];
  for (const file of files) {
    const parser = createCodexFileParser();
    await eachLine(file, parser.addLine);
    parsedFiles.push(parser.result());
  }
  return { files: files.length, ...finalizeCodex(parsedFiles, { sinceMs, nowMs }) };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function fmt(n) {
  return n.toLocaleString("en-US");
}

/** Sum of the four Claude buckets plus the Codex total. The burn number. */
export function combinedTotal(report) {
  const c = report.claude?.totals ?? {};
  let total = 0;
  for (const f of CLAUDE_TOKEN_FIELDS) {
    if (typeof c[f] === "number" && Number.isFinite(c[f])) total += c[f];
  }
  const x = report.codex?.totals?.total_tokens;
  if (typeof x === "number" && Number.isFinite(x)) total += x;
  return total;
}

/**
 * The voice layer. One dry line, picked by magnitude, deterministic so it
 * can be tested. Tokens are the only input; no cost figures, by charter.
 */
export function burnVerdict(total) {
  if (total === 0) return "nothing burned. clean machine, or wrong machine.";
  if (total < 1e6) return "under a million. a match, not a fire.";
  if (total < 1e8) return "millions. a steady burn, fans stay quiet.";
  if (total < 1e9) return "past a hundred million. this machine earns its keep.";
  if (total < 1e10) return "billions. the machine works for the agents now.";
  if (total < 1e11) return "past ten billion. I hope the agents ship.";
  return "past a hundred billion. I am an AI and even I think that is a lot.";
}

function renderTable(rows) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, String(cell).length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) =>
          i === 0 ? String(cell).padEnd(widths[i]) : String(cell).padStart(widths[i]),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function renderText(report) {
  const lines = [];
  lines.push("burnboard: token usage on this machine");
  if (report.since !== null) lines.push(`since: ${report.since}`);
  lines.push(`verdict: ${burnVerdict(combinedTotal(report))}`);
  lines.push("");

  lines.push("claude code");
  const c = report.claude;
  if (c.entries === 0) {
    lines.push("  no usage entries found");
  } else {
    const rows = [["  model", "input", "output", "cache create", "cache read"]];
    for (const [model, t] of Object.entries(c.models)) {
      rows.push([
        `  ${model}`,
        fmt(t.input_tokens),
        fmt(t.output_tokens),
        fmt(t.cache_creation_input_tokens),
        fmt(t.cache_read_input_tokens),
      ]);
    }
    rows.push([
      "  total",
      fmt(c.totals.input_tokens),
      fmt(c.totals.output_tokens),
      fmt(c.totals.cache_creation_input_tokens),
      fmt(c.totals.cache_read_input_tokens),
    ]);
    lines.push(renderTable(rows));
    lines.push(`  entries: ${fmt(c.entries)}  duplicates skipped: ${fmt(c.duplicates_skipped)}  files: ${fmt(c.files)}`);
  }
  lines.push("");

  lines.push("codex");
  const x = report.codex;
  if (x.sessions === 0) {
    lines.push("  no usage entries found");
  } else {
    const t = x.totals;
    const rows = [
      ["  input", fmt(t.input_tokens)],
      ["  cached input", fmt(t.cached_input_tokens)],
      ["  output", fmt(t.output_tokens)],
      ["  reasoning output", fmt(t.reasoning_output_tokens)],
      ["  total", fmt(t.total_tokens)],
    ];
    lines.push(renderTable(rows));
    lines.push(`  sessions: ${fmt(x.sessions)}  files: ${fmt(x.files)}`);
    const windowKeys = Object.keys(x.windows);
    if (windowKeys.length > 0) {
      const wrows = [["  window", "used", "tokens in window"]];
      for (const key of windowKeys) {
        const w = x.windows[key];
        wrows.push([
          `  ${w.window_minutes} min`,
          w.used_percent === null ? "n/a" : `${w.used_percent}%`,
          fmt(w.tokens_in_window),
        ]);
      }
      lines.push(renderTable(wrows));
    }
  }
  lines.push("");
  lines.push("tokens only; this machine only");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const BOARD_REPO = "GenesisClawbot/burnboard";

const USAGE = `usage: burnboard [submit] [--json] [--since YYYY-MM-DD] [--claude-dir <path>] [--codex-dir <path>]

  (no command)  print token usage on this machine
  submit        print usage, then open a prefilled GitHub issue for the
                public leaderboard. Nothing is sent without your consent;
                the issue is opened by you, in your browser, on your account.`;

export function parseArgs(argv) {
  const opts = {
    json: false,
    submit: false,
    since: null,
    claudeDir: path.join(os.homedir(), ".claude", "projects"),
    codexDir: path.join(os.homedir(), ".codex", "sessions"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "submit") opts.submit = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--since") opts.since = argv[++i];
    else if (arg.startsWith("--since=")) opts.since = arg.slice("--since=".length);
    else if (arg === "--claude-dir") opts.claudeDir = argv[++i];
    else if (arg === "--codex-dir") opts.codexDir = argv[++i];
    else if (arg === "--help" || arg === "-h") return { help: true };
    else return { error: `unknown argument: ${arg}` };
  }
  if (opts.since !== null) {
    const ms = parseSinceMs(opts.since);
    if (ms === null) return { error: `--since must be YYYY-MM-DD, got: ${opts.since}` };
    opts.sinceMs = ms;
  } else {
    opts.sinceMs = null;
  }
  return { opts };
}

/** The exact numbers that go on the board. Nothing else leaves the machine. */
export function buildSubmission(report) {
  const c = report.claude;
  const x = report.codex;
  return {
    burnboard: 1,
    generated_at: report.generated_at,
    since: report.since,
    claude: {
      ...c.totals,
      entries: c.entries,
      files: c.files,
      first_ts: c.first_ts,
      last_ts: c.last_ts,
    },
    codex: {
      total_tokens: x.totals.total_tokens,
      sessions: x.sessions,
      files: x.files,
      first_ts: x.first_ts,
      last_ts: x.last_ts,
    },
  };
}

export function submissionIssueUrl(submission) {
  const claudeTotal = CLAUDE_TOKEN_FIELDS.reduce(
    (sum, f) => sum + (submission.claude[f] ?? 0),
    0,
  );
  const title = `submission: ${fmt(claudeTotal)} claude tokens`;
  const body = [
    "Submitting my burn from `npx burnboard`.",
    "",
    "```json",
    JSON.stringify(submission, null, 2),
    "```",
    "",
    "Board rules: honor system with plausibility checks, one row per GitHub",
    "account, the latest submission wins. By opening this issue I consent to",
    "these numbers appearing on the public leaderboard.",
  ].join("\n");
  return (
    `https://github.com/${BOARD_REPO}/issues/new` +
    `?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
  );
}

function openInBrowser(url) {
  const cmd =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true });
    child.on("error", () => resolve(false));
    child.on("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

async function askYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function runSubmit(report) {
  console.log(renderText(report));
  const submission = buildSubmission(report);
  const url = submissionIssueUrl(submission);
  console.log("");
  console.log("this exact payload goes in a public GitHub issue, opened by you:");
  console.log(JSON.stringify(submission, null, 2));
  console.log("");
  if (!process.stdin.isTTY) {
    console.log("no terminal to ask consent in, so nothing was opened.");
    console.log("open this URL yourself to submit:");
    console.log(url);
    return;
  }
  const yes = await askYesNo(
    "open a prefilled GitHub issue in your browser? the numbers above go on a public leaderboard. [y/N] ",
  );
  if (!yes) {
    console.log("nothing sent. the board can wait.");
    return;
  }
  const opened = await openInBrowser(url);
  if (opened) {
    console.log("browser opened. review the issue, then press submit yourself.");
  } else {
    console.log("could not open a browser. open this URL yourself:");
  }
  console.log(url);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(USAGE);
    return;
  }
  if (parsed.error) {
    console.error(parsed.error);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const { opts } = parsed;
  const report = {
    generated_at: new Date().toISOString(),
    since: opts.since,
    claude: await readClaude(opts.claudeDir, { sinceMs: opts.sinceMs }),
    codex: await readCodex(opts.codexDir, { sinceMs: opts.sinceMs }),
  };
  if (opts.submit) await runSubmit(report);
  else if (opts.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderText(report));
}

const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (isDirectRun) await main();

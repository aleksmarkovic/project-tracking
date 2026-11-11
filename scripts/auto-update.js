#!/usr/bin/env node
// Auto-update. Runs Claude Code headlessly to sync assigned Jira and Linear tickets and log today's
// work into the tracker. launchd starts it on the hour and half hour (see install-auto-update.js), and
// it exits straight away unless it's in one of its slots (EVERY.update in lib/schedule.js) or run with --now.
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../lib/db.js';
import { EVERY, slotStart } from '../lib/schedule.js';
import { listTicketSources, recordAutoRun } from '../lib/store.js';

// When it runs is in lib/schedule.js.
const CONFIG = {
  markDone: true, // a task moves to Done when its ticket is done
  model: 'sonnet',
  maxBudgetUsd: 1, // per run
  timeoutMs: 15 * 60_000,
};

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TRACK = join(ROOT, 'bin', 'track.js');
const GATHER = join(homedir(), '.claude', 'skills', 'daily-status', 'scripts', 'gather_local.py');
const CLAUDE = process.env.CLAUDE_BIN ?? join(homedir(), '.local', 'bin', 'claude');
const LOG_DIR = join(homedir(), 'Library', 'Logs', 'project-tracking');
const LOG_FILE = join(LOG_DIR, 'auto-update.log');
const LOCK_DIR = join(LOG_DIR, 'auto-update.lock');

// Everything else is refused in dontAsk mode, so a run can only read tickets and use the tracker.
const ALLOWED_TOOLS = [
  `Bash(node ${TRACK} *)`,
  `Bash(python3 ${GATHER})`,
  'mcp__claude_ai_Atlassian_Rovo__searchJiraIssuesUsingJql',
  'mcp__claude_ai_Linear__list_issues',
  'ToolSearch',
];

// Step 2 of the prompt, built from each project's Jira site and Linear team (set with `track project jira`
// and `track project linear`), so no client name lives in the repo.
function ticketSourcesSection(sources) {
  const jira = sources.filter((p) => p.jira_site);
  const linear = sources.filter((p) => p.linear_team);
  if (!jira.length && !linear.length) return 'No project has a Jira site or Linear team set, so skip this step.';
  const parts = [];
  if (jira.length) {
    parts.push(`Jira: for each site below, call \`searchJiraIssuesUsingJql\` with the site as cloudId, fields \`["summary", "status"]\` and maxResults 100, once for each query:
- \`assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC\`
- \`assignee = currentUser() AND statusCategory = Done AND updated >= -3d\`

${jira.map((p) => `- \`${p.jira_site}\`: project \`${p.slug}\``).join('\n')}`);
  }
  if (linear.length) {
    parts.push(`Linear: call \`list_issues\` with assignee \`"me"\`, limit 100, fields \`["id", "title", "status", "statusType", "team", "url"]\`. Each team below belongs to a project. Skip issues from any other team.

${linear.map((p) => `- team \`${p.linear_team}\`: project \`${p.slug}\``).join('\n')}`);
  }
  const links = [
    jira.length && "- For Jira, `link` is `https://<site>/browse/<KEY>` and `state` is `fields.status.statusCategory.key` (`new`, `indeterminate` or `done`).",
    linear.length && '- For Linear, `link` is the issue `url` and `state` is `statusType`.',
  ].filter(Boolean);
  parts.push(`Then send every ticket in one call:

\`node {{TRACK}} tickets '<json array>'{{TICKET_FLAGS}}\`

Each item is \`{"project": "<project>", "link": "<url>", "title": "<summary>", "status": "<status name>", "state": "<state>"}\`:
${links.join('\n')}

The command decides what to add and move. Don't second-guess it. Pass the JSON in single quotes, and escape any single quote inside it as \`'\\''\`.`);
  return parts.join('\n\n');
}

function localISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function log(line) {
  await appendFile(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
}

// mkdir is atomic, so it doubles as a lock. A lock older than the timeout belongs to a dead run.
async function takeLock() {
  try {
    await mkdir(LOCK_DIR);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const { mtimeMs } = await stat(LOCK_DIR);
    if (Date.now() - mtimeMs < CONFIG.timeoutMs + 60_000) return false;
    await rm(LOCK_DIR, { recursive: true, force: true });
    await mkdir(LOCK_DIR);
    return true;
  }
}

function runClaude(prompt) {
  return new Promise((resolve) => {
    const args = [
      '-p',
      '--output-format', 'json',
      '--model', CONFIG.model,
      '--max-budget-usd', String(CONFIG.maxBudgetUsd),
      '--no-session-persistence',
      '--permission-mode', 'dontAsk',
      '--allowedTools', ...ALLOWED_TOOLS,
    ];
    const child = spawn(CLAUDE, args, { cwd: ROOT, env: { ...process.env, TRACK_SOURCE: 'auto' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGTERM'), CONFIG.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(prompt);
  });
}

async function main() {
  const now = new Date();
  if (!slotStart(now, EVERY.update) && !process.argv.includes('--now')) return;

  await mkdir(LOG_DIR, { recursive: true });
  if (!(await takeLock())) {
    await log('skipped: the previous run is still going');
    return;
  }

  try {
    const template = await readFile(join(ROOT, 'scripts', 'auto-update-prompt.md'), 'utf8');
    const prompt = template
      .replaceAll('{{TICKET_SOURCES}}', ticketSourcesSection(await listTicketSources()))
      .replaceAll('{{TODAY}}', localISO(now))
      .replaceAll('{{TRACK}}', TRACK)
      .replaceAll('{{GATHER}}', GATHER)
      .replaceAll('{{TICKET_FLAGS}}', CONFIG.markDone ? '' : ' --keep-open');

    const { code, signal, stdout, stderr } = await runClaude(prompt);
    let result = null;
    try {
      result = JSON.parse(stdout);
    } catch {
      // Not JSON: the CLI failed before it started the session. stderr says why.
    }
    const ok = code === 0 && result && !result.is_error;
    const text = String(result?.result ?? '').trim();
    const summary = ok
      ? text.split('\n').filter(Boolean).at(-1) ?? 'Finished'
      : signal
        ? `Stopped after ${CONFIG.timeoutMs / 60_000} minutes`
        : (text || stderr.trim() || `claude exited with code ${code}`).split('\n').filter(Boolean).at(-1);
    const costUsd = typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null;

    await recordAutoRun({ startedAt: now, ok, summary, costUsd });
    await log(`${ok ? 'ok' : 'FAILED'}${costUsd == null ? '' : ` $${costUsd.toFixed(2)}`} ${summary}`);
    if (!ok) await log(`details: ${(stderr || stdout).trim().slice(-2000)}`);
    if (process.argv.includes('--now')) console.log(`${ok ? 'OK' : 'FAILED'}: ${summary}`);
    process.exitCode = ok ? 0 : 1;
  } finally {
    await rm(LOCK_DIR, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (err) {
  await mkdir(LOG_DIR, { recursive: true });
  await log(`FAILED before running: ${err.stack ?? err}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

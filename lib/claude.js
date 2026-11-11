// Runs the Claude CLI headlessly. lib/review.js uses `askClaude` for PR reviews.
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const CLAUDE = process.env.CLAUDE_BIN ?? join(homedir(), '.local', 'bin', 'claude');
const TIMEOUT_MS = 60_000;

// The CLI failed or answered with something unusable. The server sends it as a 502. `costUsd` is
// what the failed run spent, when the CLI got far enough to say.
export class ClaudeError extends Error {
  constructor(message, costUsd = null) {
    super(message);
    this.costUsd = costUsd;
  }
}
// A call is already running. The server sends it as a 429.
export class BusyError extends Error {}

// Runs in progress, so the server can stop them when it shuts down.
const children = new Set();

// A run outliving the server would keep spending with nobody to read its result.
export function stopClaudeRuns() {
  for (const child of children) child.kill('SIGTERM');
}

const duration = (ms) => (ms >= 120_000 ? `${ms / 60_000} minutes` : `${ms / 1000} seconds`);

function runClaude(args, prompt, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE, args, { cwd });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      children.delete(child);
      reject(new ClaudeError(err.code === 'ENOENT' ? `The Claude CLI isn't installed at ${CLAUDE}` : err.message));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      if (signal) return reject(new ClaudeError(`Claude took longer than ${duration(timeoutMs)}`));
      resolve({ code, stdout, stderr });
    });
    // The prompt goes on stdin because --allowedTools and --tools take a list and would swallow it.
    child.stdin.end(prompt);
  });
}

// Runs `claude -p` with `args` and returns its JSON result. Sessions aren't saved, so these runs
// don't show up in /daily-status.
export async function askClaude(args, prompt, { cwd = tmpdir(), timeoutMs = TIMEOUT_MS } = {}) {
  const { code, stdout, stderr } = await runClaude(
    ['-p', '--output-format', 'json', '--no-session-persistence', ...args],
    prompt,
    { cwd, timeoutMs },
  );
  let result = null;
  try {
    result = JSON.parse(stdout);
  } catch {
    // Not JSON: the CLI failed before it started the session. stderr says why.
  }
  if (code !== 0 || !result || result.is_error || result.subtype !== 'success') {
    const costUsd = typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null;
    if (result?.subtype === 'error_max_budget_usd') throw new ClaudeError('Claude stopped at its spending limit', costUsd);
    const reason = String(result?.result ?? '').trim() || stderr.trim() || `claude exited with code ${code}`;
    throw new ClaudeError(`Claude failed: ${reason.split('\n').filter(Boolean).at(-1)}`, costUsd);
  }
  return result;
}

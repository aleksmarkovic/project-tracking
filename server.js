import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BusyError, ClaudeError, stopClaudeRuns } from './lib/claude.js';
import { requestDailyStatus, startDailyStatuses } from './lib/daily.js';
import { applySchema, describeDbError } from './lib/db.js';
import { GitHubError, mergePullRequest } from './lib/github.js';
import { postReview, pullRequestsWithReviews, requestReview, runReviews, startReviews } from './lib/review.js';
import * as store from './lib/store.js';

const PORT = Number(process.env.PORT ?? 4567);
const HOST = process.env.HOST ?? '127.0.0.1';
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const MAX_BODY_BYTES = 1_000_000;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const routes = [
  ['GET', /^\/api\/state$/, () => store.getState()],
  // Separate from /api/state because it asks GitHub, which is slower and can fail on its own. PRs
  // waiting for the user's review carry Claude's review of them.
  ['GET', /^\/api\/github$/, (_, __, query) => pullRequestsWithReviews({ refresh: query.has('refresh') })],
  ['POST', /^\/api\/github\/merge$/, (_, body) => mergePullRequest(body)],
  ['POST', /^\/api\/reviews$/, (_, body) => requestReview(body)],
  ['POST', /^\/api\/reviews\/run$/, () => runReviews()],
  ['PATCH', /^\/api\/reviews\/(\d+)$/, ([id], body) => store.updateReview(Number(id), body)],
  ['POST', /^\/api\/reviews\/(\d+)\/post$/, ([id], body) => postReview(Number(id), body)],
  // Starts Claude writing that day's /daily-status. The result rides along on /api/state.
  ['POST', /^\/api\/daily\/([\d-]+)\/run$/, ([day]) => requestDailyStatus(day)],
  ['POST', /^\/api\/projects$/, (_, body) => store.createProject(body)],
  ['PATCH', /^\/api\/projects\/(\d+)$/, ([id], body) => store.updateProject(Number(id), body)],
  ['DELETE', /^\/api\/projects\/(\d+)$/, ([id]) => store.deleteProject(Number(id))],
  ['POST', /^\/api\/tasks$/, (_, body) => store.createTask(body)],
  ['PATCH', /^\/api\/tasks\/(\d+)$/, ([id], body) => store.updateTask(Number(id), body)],
  ['DELETE', /^\/api\/tasks\/(\d+)$/, ([id]) => store.deleteTask(Number(id))],
  ['POST', /^\/api\/activity$/, (_, body) => store.logAction(body)],
  ['DELETE', /^\/api\/activity\/(\d+)$/, ([id]) => store.deleteActivity(Number(id))],
  ['POST', /^\/api\/notes$/, (_, body) => store.createNote(body)],
  ['PATCH', /^\/api\/notes\/(\d+)$/, ([id], body) => store.updateNote(Number(id), body)],
  ['DELETE', /^\/api\/notes\/(\d+)$/, ([id]) => store.deleteNote(Number(id))],
];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  // Requiring a JSON content type means a cross-site form can't post here without a CORS preflight,
  // which this server never answers.
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw new HttpError(415, 'Send the body as application/json');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'Body must be a JSON object');
  }
}

async function serveStatic(pathname, res) {
  const file = normalize(join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) throw new HttpError(404, 'Not found');
  try {
    const content = await readFile(file);
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } catch {
    throw new HttpError(404, 'Not found');
  }
}

async function handle(req, res) {
  // Requests addressed to any other host came through a tunnel such as ngrok (or a DNS-rebinding
  // page). The page and the API stay on this machine.
  const hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
    throw new HttpError(403, 'This server only answers on localhost');
  }
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');

  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    return serveStatic(pathname, res);
  }

  // Browsers say where a request comes from. Only this page and the address bar may use the API, so
  // another site (or another app on localhost) can't make it do anything by loading a URL. curl and
  // scripts don't send the header.
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Requests from other sites are refused');

  for (const [method, pattern, handler] of routes) {
    const match = pathname.match(pattern);
    if (!match || req.method !== method) continue;
    const body = method === 'POST' || method === 'PATCH' ? await readJson(req) : undefined;
    const result = await handler(match.slice(1), body, searchParams);
    return send(res, method === 'POST' ? 201 : 200, result);
  }
  throw new HttpError(404, 'Not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    if (err instanceof store.InputError) return send(res, 400, { error: err.message });
    if (err instanceof store.NotFoundError) return send(res, 404, { error: err.message });
    if (err instanceof BusyError) return send(res, 429, { error: err.message });
    if (err instanceof ClaudeError || err instanceof GitHubError) return send(res, 502, { error: err.message });
    console.error(err);
    send(res, 500, { error: describeDbError(err) ?? 'Something went wrong on the server. Check its terminal.' });
  });
});

try {
  await applySchema();
} catch (err) {
  console.error(describeDbError(err) ?? err);
  process.exit(1);
}

// Ctrl-C, `node --watch` restarts and launchd all stop the server with a signal. Claude runs end with
// it, then the signal is raised again so the server exits as it would have.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopClaudeRuns();
    process.kill(process.pid, signal);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`Tracker running at http://localhost:${PORT}`);
  startReviews().catch((err) => console.error(err));
  startDailyStatuses().catch((err) => console.error(err));
});

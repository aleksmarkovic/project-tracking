// Open pull requests that involve the user, grouped by who has to act next. Read through the GitHub
// CLI, so it uses whatever account `gh auth login` signed in. Results are cached briefly so the
// page's polling doesn't reach GitHub on every refresh.
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { InputError, NotFoundError, listProjects, mergeInput, slugify } from './store.js';

const REPOS_DIR = process.env.REPOS_DIR ?? join(homedir(), 'Desktop', 'repos');
// Folders of unrelated side projects (same as /daily-status), so their repos map to no client.
const CONTAINERS = new Set(['me']);
const CACHE_MS = 60_000;
const MIN_REFRESH_MS = 10_000;
// A PR nobody has touched in this long is marked `stale`, and the page folds it away.
export const STALE_DAYS = 90;

// review: someone asked the user for a review. The rest are the user's own PRs.
// merge: approved. changes: a reviewer asked for changes, or only left comments. open: waiting for
// review, or a draft.
export const PR_GROUPS = ['review', 'merge', 'changes', 'open'];

const SEARCH_REVIEW = 'is:pr is:open archived:false review-requested:@me sort:created-asc';
const SEARCH_MINE = 'is:pr is:open archived:false author:@me sort:created-asc';

const QUERY = `
query($review: String!, $mine: String!) {
  viewer { login }
  review: search(query: $review, type: ISSUE, first: 50) { nodes { ...pr } }
  mine: search(query: $mine, type: ISSUE, first: 50) { nodes { ...pr } }
}
fragment pr on PullRequest {
  # Ahead of reviewDecision on purpose: asked for after it, GitHub returns only the reviews of people who
  # can still write to the repo, and a change request from a reviewer who has since lost access vanishes.
  latestOpinionatedReviews(first: 20) { nodes { state author { login } } }
  number title url state isDraft createdAt updatedAt reviewDecision mergeable mergeStateStatus headRefOid baseRefName
  author { login }
  repository { nameWithOwner viewerDefaultMergeMethod mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
  latestReviews(first: 20) { nodes { state author { __typename login } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

const CHECKS = { SUCCESS: 'passing', FAILURE: 'failing', ERROR: 'failing', PENDING: 'running', EXPECTED: 'running' };

// Why GitHub won't merge a PR right now, from its mergeStateStatus. UNKNOWN isn't here: GitHub is
// still working it out, so a merge is tried and GitHub decides.
const MERGE_BLOCKERS = { BLOCKED: 'Blocked by branch rules', BEHIND: 'Behind its base branch', DIRTY: 'Has conflicts', DRAFT: 'Draft' };
const MERGE_FLAGS = { merge: '--merge', squash: '--squash', rebase: '--rebase' };

// gh failed or GitHub refused. The server sends it as a 502.
export class GitHubError extends Error {}

// `input` goes to gh on stdin, for `gh api --input -`.
function gh(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('gh', args, { timeout: 20_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.code === 'ENOENT') return reject(new GitHubError("The GitHub CLI isn't installed. Install it with `brew install gh`."));
      if (/auth login|not logged in|authenticat/i.test(stderr)) return reject(new GitHubError("The GitHub CLI isn't signed in. Run `gh auth login`."));
      if (err.killed) return reject(new GitHubError('GitHub took too long to answer.'));
      reject(new GitHubError(`GitHub: ${apiErrorOf(stdout) ?? (stderr.trim().split('\n').at(-1) || err.message)}`));
    });
    child.stdin.end(input ?? '');
  });
}

// `gh api` prints GitHub's error body on stdout and only "gh: Unprocessable Entity (HTTP 422)" on
// stderr. The body says what was wrong, e.g. a comment on a line that isn't in the diff.
function apiErrorOf(stdout) {
  try {
    const { message, errors } = JSON.parse(stdout);
    const details = (Array.isArray(errors) ? errors : []).map((e) => (typeof e === 'string' ? e : e.message ?? e.code)).filter(Boolean);
    return message ? [message, ...details].join(': ') : null;
  } catch {
    return null;
  }
}

// "owner/repo" (lowercase) → { folder: top-level folder in REPOS_DIR, dir: the clone }, read from each
// clone's origin remote. A folder named "<client>-<suffix>" counts as <client> when that folder exists too.
async function repoFolders() {
  const folders = new Map();
  let names;
  try {
    names = (await readdir(REPOS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch {
    return folders;
  }
  const clientOf = (name) => names.find((other) => other !== name && !CONTAINERS.has(other) && name.startsWith(`${other}-`)) ?? name;
  for (const name of names) {
    if (CONTAINERS.has(name)) continue;
    const dir = join(REPOS_DIR, name);
    const own = await originOf(dir);
    const clones = own ? [{ remote: own, dir }] : await Promise.all(
      (await readdir(dir, { withFileTypes: true }).catch(() => []))
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map(async (d) => ({ remote: await originOf(join(dir, d.name)), dir: join(dir, d.name) })),
    );
    for (const { remote, dir: clone } of clones) {
      if (remote && !folders.has(remote)) folders.set(remote, { folder: clientOf(name), dir: clone });
    }
  }
  return folders;
}

async function originOf(repo) {
  const config = await readFile(join(repo, '.git', 'config'), 'utf8').catch(() => '');
  const origin = config.split(/^\[/m).find((section) => section.startsWith('remote "origin"'));
  const url = origin?.match(/^\s*url\s*=\s*(.+)$/m)?.[1].trim();
  const match = url?.match(/github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

function groupOf(pr, approvedBy, changesBy, commentedBy) {
  if (pr.isDraft) return 'open';
  if (changesBy.length) return 'changes';
  // Comments with nobody approving also wait on the author.
  if (commentedBy.length && !approvedBy.length) return 'changes';
  // Branch protection that wants more approvals reports REVIEW_REQUIRED even after one approval.
  if (pr.reviewDecision === 'REVIEW_REQUIRED') return 'open';
  if (pr.reviewDecision === 'APPROVED' || approvedBy.length) return 'merge';
  return 'open';
}

function shape(pr, fromReviewSearch, folders) {
  const reviewers = pr.reviewRequests.nodes
    .map((n) => n.requestedReviewer?.login ?? n.requestedReviewer?.name)
    .filter(Boolean);
  // Most repos don't require reviews, so GitHub leaves reviewDecision empty; read the reviews
  // instead. A reviewer asked to look again no longer counts with their old verdict.
  const verdicts = pr.latestOpinionatedReviews.nodes.filter((r) => r.author && !reviewers.includes(r.author.login));
  const approvedBy = verdicts.filter((r) => r.state === 'APPROVED').map((r) => r.author.login);
  const changesBy = verdicts.filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => r.author.login);
  // Reviewers whose reviews were only comments. The author's own replies in review threads and bots
  // count as comment reviews too, so they're left out.
  const commentedBy = pr.latestReviews.nodes
    .filter((r) => r.state === 'COMMENTED' && r.author && r.author.__typename !== 'Bot' && r.author.login !== pr.author?.login)
    .map((r) => r.author.login)
    .filter((login) => !reviewers.includes(login) && !approvedBy.includes(login) && !changesBy.includes(login));
  const local = folders.get(pr.repository.nameWithOwner.toLowerCase());
  return {
    group: fromReviewSearch ? 'review' : groupOf(pr, approvedBy, changesBy, commentedBy),
    url: pr.url,
    number: pr.number,
    title: pr.title,
    repo: pr.repository.nameWithOwner,
    folder: local?.folder ?? null,
    // The local clone, where a Claude review runs (lib/review.js).
    clone: local?.dir ?? null,
    head_sha: pr.headRefOid,
    base_ref: pr.baseRefName,
    author: pr.author?.login ?? 'ghost',
    draft: pr.isDraft,
    opened_at: pr.createdAt,
    updated_at: pr.updatedAt,
    stale: Date.now() - new Date(pr.updatedAt) > STALE_DAYS * 86_400_000,
    checks: CHECKS[pr.commits.nodes[0]?.commit.statusCheckRollup?.state] ?? null,
    conflicts: pr.mergeable === 'CONFLICTING',
    reviewers,
    approved_by: approvedBy,
    changes_by: changesBy,
    commented_by: commentedBy,
    // How Merge on the page merges it, and why GitHub won't yet (null when it can).
    merge_method: mergeMethod(pr.repository),
    merge_blocker: MERGE_BLOCKERS[pr.mergeStateStatus] ?? null,
  };
}

// The method GitHub's own merge button would pick: the user's last one, if the repo still allows it.
function mergeMethod(repo) {
  const allowed = [['MERGE', repo.mergeCommitAllowed], ['SQUASH', repo.squashMergeAllowed], ['REBASE', repo.rebaseMergeAllowed]]
    .filter(([, ok]) => ok)
    .map(([method]) => method);
  const method = allowed.includes(repo.viewerDefaultMergeMethod) ? repo.viewerDefaultMergeMethod : allowed[0];
  return method?.toLowerCase() ?? null;
}

// GitHub's search lags a merge or close by a minute or so, but each PR's own state is current.
const isOpen = (pr) => pr.number && pr.state === 'OPEN';

async function fetchFromGitHub() {
  const [output, folders] = await Promise.all([
    gh(['api', 'graphql', '-f', `query=${QUERY}`, '-f', `review=${SEARCH_REVIEW}`, '-f', `mine=${SEARCH_MINE}`]),
    repoFolders(),
  ]);
  const { viewer, review, mine } = JSON.parse(output).data;
  const prs = [
    ...review.nodes.filter(isOpen).map((pr) => shape(pr, true, folders)),
    ...mine.nodes.filter(isOpen).map((pr) => shape(pr, false, folders)),
  ];
  return { viewer: viewer.login, prs, fetched_at: new Date().toISOString(), error: null };
}

// The client project a PR belongs to: its clone's folder, else the GitHub org or repo name.
// "Acme Co" matches acme-co and AcmeCo alike.
function attachProjects(data, projects) {
  const squash = (value) => slugify(value).replace(/-/g, '');
  const candidates = projects.filter((p) => !p.is_common);
  const prs = data.prs.map((pr) => {
    const [owner, name] = pr.repo.split('/');
    const keys = [pr.folder, owner, name].filter(Boolean).map(squash);
    const project = keys.map((key) => candidates.find((p) => squash(p.name) === key)).find(Boolean);
    return { ...pr, project_id: project?.id ?? null, project_name: project?.name ?? null, project_color: project?.color ?? null };
  });
  return { ...data, prs, stale_days: STALE_DAYS };
}

let cache = null;
let inflight = null;

// Cached for a minute. `refresh` asks for fresh data, but never more than once every 10 seconds.
// When GitHub fails, the last good list comes back with `error` set.
export async function getPullRequests({ refresh = false } = {}) {
  const age = cache ? Date.now() - cache.at : Infinity;
  if (age >= (refresh ? MIN_REFRESH_MS : CACHE_MS)) {
    inflight ??= fetchFromGitHub()
      .catch((err) => ({ viewer: null, prs: [], fetched_at: null, ...cache?.data, error: err.message }))
      .then((data) => (cache = { data, at: Date.now() }))
      .finally(() => (inflight = null));
    await inflight;
  }
  return attachProjects(cache.data, await listProjects());
}

const REVIEW_FLAGS = { comment: '--comment', approve: '--approve', request_changes: '--request-changes' };

function repoAndNumber(url) {
  const match = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
  if (!match) throw new InputError(`Not a pull request link: ${url}`);
  return { repo: match[1], number: Number(match[2]) };
}

// The lines of a PR at `headSha` that GitHub takes a comment on: path → { RIGHT, LEFT } sets of line
// numbers in the new and the old file. Read from the diff against `base`, as the PR shows it. GitHub
// lists up to 300 files, and none for a file too big or binary to diff.
export async function diffLines(repo, base, headSha) {
  const out = await gh(['api', `repos/${repo}/compare/${encodeURIComponent(base)}...${headSha}?per_page=1`, '--jq', '[.files[] | {filename, patch}]']);
  const files = new Map();
  for (const { filename, patch } of JSON.parse(out)) {
    const sides = { RIGHT: new Set(), LEFT: new Set() };
    let left = 0;
    let right = 0;
    for (const row of (patch ?? '').split('\n')) {
      const hunk = row.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) [left, right] = [Number(hunk[1]), Number(hunk[2])];
      else if (row.startsWith('+')) sides.RIGHT.add(right++);
      else if (row.startsWith('-')) sides.LEFT.add(left++);
      else if (row.startsWith(' ')) {
        sides.LEFT.add(left++);
        sides.RIGHT.add(right++);
      }
    }
    files.set(filename, sides);
  }
  return files;
}

// Whether GitHub would take `comment` ({ path, line, start_line?, side }): every line it covers has to
// be in the diff, in one hunk. A single comment that isn't makes GitHub refuse the whole review.
export function onDiff(comment, lines) {
  const side = lines.get(comment.path)?.[comment.side];
  if (!side) return false;
  for (let n = comment.start_line ?? comment.line; n <= comment.line; n += 1) if (!side.has(n)) return false;
  return true;
}

// Posts the user's review of a PR as them. `event` is one of store.REVIEW_EVENTS. GitHub then drops
// the review request, so the cached list is marked old and the next read fetches a fresh one.
// `comments` go on their lines of the diff at `commitId`, the commit Claude reviewed. Without any, the
// review goes on the PR's latest commit.
export async function submitReview(url, event, body, { commitId, comments = [] } = {}) {
  if (!comments.length) {
    await gh(['pr', 'review', url, REVIEW_FLAGS[event], ...(body ? ['--body', body] : [])]);
  } else {
    const { repo, number } = repoAndNumber(url);
    const payload = {
      commit_id: commitId,
      event: event.toUpperCase(),
      ...(body ? { body } : {}),
      comments: comments.map(({ path, line, start_line: startLine, side, body: text }) => ({
        path, line, side, body: text, ...(startLine ? { start_line: startLine, start_side: side } : {}),
      })),
    };
    await gh(['api', '--method', 'POST', `repos/${repo}/pulls/${number}/reviews`, '--input', '-'], { input: JSON.stringify(payload) });
  }
  if (cache) cache.at = 0;
}

// { url, head_sha } → merges one of the user's approved PRs (the "merge" group) with its merge_method.
// GitHub refuses if the PR's head is no longer head_sha, so a push made after the page loaded is never
// merged unseen.
export async function mergePullRequest(input) {
  const { url, headSha } = mergeInput(input);
  const pr = (await getPullRequests()).prs.find((p) => p.url === url && p.group === 'merge');
  if (!pr) throw new NotFoundError("That PR isn't approved and open");
  if (pr.merge_blocker) throw new InputError(`GitHub won't merge it yet: ${pr.merge_blocker.toLowerCase()}`);
  if (!pr.merge_method) throw new InputError("The repo doesn't allow any merge method");
  await gh(['pr', 'merge', pr.url, MERGE_FLAGS[pr.merge_method], '--match-head-commit', headSha]);
  if (cache) cache.at = 0;
  return { merged: pr.url, method: pr.merge_method };
}

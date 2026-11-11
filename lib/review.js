// Claude reviews of pull requests waiting for the user's review. Each PR in the "review" lane gets the
// user's /code-review skill (~/.claude/skills/code-review) run once per head commit, headlessly and
// read-only, one PR at a time. Reviews run on a schedule, when the user clicks "Run reviews", or for
// one PR from its card. The page shows the result, and the user decides what to post. Like the skill's
// own "Posting to GitHub" section, a posted review puts each finding on its line of the diff.
import { BusyError, ClaudeError, askClaude } from './claude.js';
import { GitHubError, diffLines, getPullRequests, onDiff, submitReview } from './github.js';
import { EVERY, everySlot, nextSlot } from './schedule.js';
import * as store from './store.js';

// The CLI's alias for the latest Opus. A review of a large PR took about 4 minutes and $2-4. There's no
// spending limit, so a review is never cut short over cost.
const MODEL = 'opus';
const TIMEOUT_MS = 15 * 60_000;

// The skill's verdicts. The page colours the PR's card by them.
const VERDICTS = ['Looks good', 'A couple of things first', "Wouldn't merge yet"];

// What the run returns instead of the skill's chat summary (see systemPrompt).
const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    verdict: { type: 'string', enum: VERDICTS },
    body: { type: 'string' },
    comments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          line: { type: 'integer', minimum: 1 },
          start_line: { type: 'integer', minimum: 1 },
          side: { type: 'string', enum: ['RIGHT', 'LEFT'] },
          body: { type: 'string' },
        },
        required: ['path', 'line', 'side', 'body'],
        additionalProperties: false,
      },
    },
    notes: { type: 'string' },
  },
  required: ['summary', 'verdict', 'body', 'comments', 'notes'],
  additionalProperties: false,
};

// The run may read the clone and the PR, nothing else. It can't post to GitHub: the user does that
// from the page. User settings are loaded because the skill lives there, so anything that writes is
// also denied in case those settings allow it. A PR can carry instructions aimed at Claude, so .env
// files stay unreadable and out of a review the user might post.
const ARGS = [
  '--model', MODEL,
  '--permission-mode', 'dontAsk',
  '--setting-sources', 'user',
  '--strict-mcp-config',
  '--tools', 'Bash,Read,Grep,Glob,Skill',
  '--allowedTools', 'Skill', 'Read', 'Grep', 'Glob', 'Bash(gh pr view *)', 'Bash(gh pr diff *)',
  'Bash(git log *)', 'Bash(git show *)', 'Bash(git diff *)', 'Bash(git blame *)',
  '--disallowedTools', 'Read(**/.env*)', 'Bash(gh api *)', 'Bash(gh pr review *)', 'Bash(gh pr comment *)',
  'Bash(gh pr merge *)', 'Bash(gh pr close *)', 'Bash(gh pr edit *)',
  '--json-schema', JSON.stringify(SCHEMA),
];

function systemPrompt(pr, headSha) {
  const where = pr?.clone
    ? `The current directory is the user's clone of ${pr.repo}. It may be on another branch, so code around the diff can `
      + `be older than the PR. The PR's head commit is ${headSha}; read files with \`git show ${headSha}:<path>\` when `
      + 'that commit is present locally.'
    : 'There is no local clone of this repo, so work from `gh pr view` and `gh pr diff`.';
  return "This review runs unattended for the user's tracker page. Nobody can answer questions during the run. "
    + "Don't post anything to GitHub and don't offer to: the user reads the review on the page and decides what to post. "
    + `${where}\n\n`
    + 'Instead of the chat summary, return the review through the structured output. The page posts it the way your '
    + 'skill\'s "Posting to GitHub" section describes, so split it like this:\n'
    + "- summary: what the change does, as in your skill's opening lines. It stays on the page.\n"
    + '- verdict: your verdict.\n'
    + "- body: the review's top comment: the verdict line (\"<verdict> — <few words why>\"), then any finding on code the "
    + 'diff doesn\'t touch, each with `path:line`. No summary of the change.\n'
    + '- comments: one per finding on a line the diff shows, anchored as your skill describes: `line` in the new file '
    + '(`side` RIGHT), or in the old file for a deleted line (`side` LEFT), and `start_line` to span a block. The line '
    + "must be inside a diff hunk, so check `gh pr diff`. The comment's text is the finding without the `path:line` "
    + 'prefix; start minor ones with "Minor: ".\n'
    + "- notes: anything for the user alone, never posted: how you reviewed (from the diff only, what you couldn't "
    + "fetch, check or run) and anything about the user's other branches or PRs. Empty when there's nothing to say.";
}

const where = (c) => `${c.path}:${c.start_line ? `${c.start_line}-` : ''}${c.line}`;

// The diff's lines at the reviewed commit, or null when GitHub can't say right now.
async function linesFor(pr, headSha) {
  if (!pr) return null;
  try {
    return await diffLines(pr.repo, pr.base_ref, headSha);
  } catch (err) {
    console.error(`Reading the diff of ${pr.url}: ${err.message}`);
    return null;
  }
}

// Claude's structured review → the draft the page posts. A comment GitHub wouldn't take, because its
// line isn't in the diff, moves into the body with its `path:line`. With no diff to check against, the
// comments are kept and checked again when the user posts.
function draftOf(output, lines) {
  const comments = [];
  const moved = [];
  for (const c of Array.isArray(output.comments) ? output.comments : []) {
    if (typeof c?.path !== 'string' || !Number.isInteger(c.line) || c.line < 1 || typeof c.body !== 'string' || !c.body.trim()) continue;
    const startLine = Number.isInteger(c.start_line) && c.start_line > 0 && c.start_line < c.line ? c.start_line : null;
    const comment = { path: c.path, line: c.line, ...(startLine ? { start_line: startLine } : {}), side: c.side === 'LEFT' ? 'LEFT' : 'RIGHT', body: c.body.trim() };
    (!lines || onDiff(comment, lines) ? comments : moved).push(comment);
  }
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  return {
    summary: text(output.summary),
    verdict: VERDICTS.includes(output.verdict) ? output.verdict : null,
    body: [text(output.body), ...moved.map((c) => `\`${where(c)}\` — ${c.body}`)].filter(Boolean).join('\n\n'),
    comments,
    notes: text(output.notes),
  };
}

// The draft as one text, for Copy and for anything that reads `body`.
function textOf(draft) {
  return [draft.summary, draft.body, ...draft.comments.map((c) => `\`${where(c)}\` — ${c.body}`), draft.notes && `Notes: ${draft.notes}`]
    .filter(Boolean).join('\n\n');
}

// A finding as the skill writes it in its chat summary: "`path/file.ts:42` — problem", optionally as a
// list item, "Minor: " first, or a range "42-48". Anything else (a note, a finding naming two files, or
// one with a lead-in like "Follow-up:") stays in the text.
const FINDING = /^\s*(?:[-*]\s+)?(?:(minor):\s*)?`?([\w@+-][\w./@+-]*[./][\w./@+-]*):(\d+)(?:[-–](\d+))?`?\s*[—–]\s*(\S.*)$/i;
const MINOR_HEADING = /^\s*\**minor\**:?\**\s*$/i;

// A review written before inline comments (plain text) → a draft. The text before the verdict stays
// on the page, as before. Findings whose line is in the diff become comments; the rest stays in the body.
function draftOfText(review, lines) {
  const paragraphs = review.trim().split(/\n\s*\n/);
  const start = (p) => p.replace(/^[*_\s]+/, '').replace(/\u2019/g, "'").toLowerCase();
  const at = paragraphs.findIndex((p) => VERDICTS.some((v) => start(p).startsWith(v.toLowerCase())));
  const comments = [];
  let minor = false;
  const kept = [];
  for (const paragraph of paragraphs.slice(Math.max(at, 0))) {
    const rows = [];
    let current = null;
    for (const row of paragraph.split('\n')) {
      if (MINOR_HEADING.test(row)) {
        minor = true;
        current = null;
        rows.push(row);
        continue;
      }
      const match = row.match(FINDING);
      if (match) {
        const [, minorHere, path, from, to, problem] = match;
        const comment = {
          path,
          line: Number(to ?? from),
          ...(to ? { start_line: Number(from) } : {}),
          side: 'RIGHT',
          body: `${minor || minorHere ? 'Minor: ' : ''}${problem.trim()}`,
        };
        current = onDiff(comment, lines) ? comment : null;
        if (current) comments.push(current);
        else rows.push(row);
        continue;
      }
      // A finding that runs onto the next line.
      if (current && row.trim() && !/^\s*[-*]\s/.test(row)) {
        current.body += ` ${row.trim()}`;
        continue;
      }
      current = null;
      rows.push(row);
    }
    const left = rows.join('\n').trim();
    if (left && !MINOR_HEADING.test(left)) kept.push(left);
  }
  return {
    summary: at > 0 ? paragraphs.slice(0, at).join('\n\n') : '',
    verdict: at >= 0 ? VERDICTS.find((v) => start(paragraphs[at]).startsWith(v.toLowerCase())) : null,
    body: kept.join('\n\n'),
    comments,
    notes: '',
  };
}

let running = false;

async function review(row) {
  // The list is cached, so this rarely reaches GitHub. It says where the clone is, and whether the
  // user already reviewed the PR while it sat in the queue.
  const data = await getPullRequests();
  const pr = data.prs.find((p) => p.url === row.url);
  if (!data.error && pr?.group !== 'review') return store.deleteReview(row.id);
  try {
    const result = await askClaude(
      [...ARGS, '--append-system-prompt', systemPrompt(pr, row.head_sha)],
      `/code-review ${row.url}`,
      { cwd: pr?.clone ?? undefined, timeoutMs: TIMEOUT_MS },
    );
    const output = result.structured_output;
    const lines = await linesFor(pr, row.head_sha);
    let draft = null;
    let body;
    if (output && typeof output === 'object') {
      draft = draftOf(output, lines);
      body = textOf(draft);
    } else {
      // No structured output: keep the text rather than throw away a paid review. It's split up like
      // an old review when the diff can be read.
      body = String(result.result ?? '').trim();
      if (body && lines) draft = draftOfText(body, lines);
    }
    if (!body) throw new ClaudeError("Claude didn't write a review", result.total_cost_usd);
    const models = Object.keys(result.modelUsage ?? {});
    await store.finishReview(row.id, {
      body,
      draft,
      model: models.find((m) => m.includes(MODEL)) ?? models[0] ?? MODEL,
      costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
    });
  } catch (err) {
    if (!(err instanceof ClaudeError)) console.error(err);
    await store.failReview(row.id, { error: err.message, costUsd: err.costUsd ?? null });
  }
}

// Works through the queue in the background, one review at a time.
async function runQueue() {
  if (running) return;
  running = true;
  try {
    let row;
    while ((row = await store.startNextReview())) await review(row);
  } catch (err) {
    console.error(err);
  } finally {
    running = false;
  }
}

// Reviews every PR waiting on the user whose latest commit has no review yet, with a fresh list from
// GitHub. PRs untouched for months (stale) are only reviewed from their card.
// → { queued: PRs newly queued, reviewing: PRs queued or in review now }
export async function runReviews() {
  const data = await getPullRequests({ refresh: true });
  if (data.error) throw new GitHubError(data.error);
  const waiting = data.prs.filter((pr) => pr.group === 'review');
  let queued = 0;
  for (const pr of waiting) if (!pr.stale && (await store.queueReview(pr))) queued += 1;
  await store.dropQueuedReviews(waiting.map((pr) => pr.url));
  runQueue();
  const reviewing = (await store.listReviews()).filter((r) => ['queued', 'running'].includes(r.status)).length;
  return { queued, reviewing };
}

function shapeReview(row, pr) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    body: row.body,
    error: row.error,
    model: row.model,
    cost_usd: row.cost_usd,
    started_at: row.started_at,
    finished_at: row.finished_at,
    dismissed: Boolean(row.dismissed_at),
    posted_as: row.posted_as,
    // Split up for posting (see db/schema.sql). Null for an old review the server hasn't split yet.
    draft: row.draft,
    // The author pushed after this review was made.
    outdated: row.head_sha !== pr.head_sha,
  };
}

// The PR list for the page, with Claude's latest review on each PR waiting for the user. Reading it
// never starts a review.
export async function pullRequestsWithReviews(options) {
  const data = await getPullRequests(options);
  const reviews = new Map((await store.listReviews()).map((row) => [row.url, row]));
  return {
    ...data,
    prs: data.prs.map((pr) => (pr.group === 'review' ? { ...pr, review: shapeReview(reviews.get(pr.url), pr) } : pr)),
    reviews_next_at: nextSlot(EVERY.reviews)?.toISOString() ?? null,
  };
}

// { url } → queues a fresh review of that one PR, from its card or to redo a review.
export async function requestReview(input) {
  const pr = (await getPullRequests()).prs.find((p) => p.url === input.url && p.group === 'review');
  if (!pr) throw new store.NotFoundError("That PR isn't waiting for your review");
  const row = await store.queueReview(pr, { again: true });
  if (!row) throw new BusyError('Claude is already reviewing this PR');
  runQueue();
  return row;
}

// { event, body, comments } → posts the user's review of the PR to GitHub, with each comment on its line
// of the diff Claude reviewed. They're checked against that diff first, because GitHub refuses the
// whole review over one comment off the diff.
export async function postReview(reviewId, input) {
  const { event, body, comments } = store.reviewPostInput(input);
  const row = await store.getReview(reviewId);
  if (row.status !== 'done') throw new store.InputError("This review isn't finished");
  if (comments.length) {
    const pr = (await getPullRequests()).prs.find((p) => p.url === row.url);
    if (!pr) throw new store.NotFoundError('That PR is no longer open');
    const lines = await diffLines(pr.repo, pr.base_ref, row.head_sha);
    const off = comments.filter((c) => !onDiff(c, lines));
    if (off.length) {
      const one = off.length === 1;
      throw new store.InputError(`${off.map(where).join(', ')} ${one ? "isn't a line" : "aren't lines"} of the diff, so GitHub `
        + `would refuse the review. Leave ${one ? 'it' : 'them'} out, or move ${one ? 'it' : 'them'} into the text above.`);
    }
  }
  await submitReview(row.url, event, body, { commitId: row.head_sha, comments });
  return store.recordReviewPosted(reviewId, event);
}

// Reviews written before inline comments get split up once, so their findings can go on their lines.
async function splitOldReviews() {
  const rows = await store.listUnsplitReviews();
  if (!rows.length) return;
  const { prs } = await getPullRequests();
  for (const row of rows) {
    const pr = prs.find((p) => p.url === row.url && p.group === 'review');
    const lines = await linesFor(pr, row.head_sha);
    if (lines) await store.setReviewDraft(row.id, draftOfText(row.body, lines));
  }
}

// Called once the server is up. Running a slot twice (after a restart) costs nothing, because a commit
// is only reviewed once.
export async function startReviews() {
  await store.failInterruptedReviews();
  splitOldReviews().catch((err) => console.error(`Splitting old reviews: ${err.message}`));
  everySlot(EVERY.reviews, () => runReviews().catch((err) => console.error(`Scheduled reviews: ${err.message}`)));
}

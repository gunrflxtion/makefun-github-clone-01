// rest.ts — GitHub REST v3 surface (repos / issues / pulls / contents / git refs).
//
// Owned by the REST+protocol worker. Exported as `handleRest(req, res, ctx)`
// per INTEGRATION.md: app.ts builds one Ctx per request (store, token,
// requestId, path, query, method, json, readBody, authed) and calls this
// handler for paths under /api/v3. Return true when handled, false when the
// path is not this surface's.
//
// Every operation goes through the shared Store (store.ts, store+git worker);
// this module keeps no repo/issue/PR state of its own. All timestamps come
// from Store.clock (logical clock, +1s per mutating operation). The Store's
// own mutating helpers (createRepo, createIssue, createPull, createLabel,
// addIssueComment, updateRef, deleteRepo) tick exactly once themselves;
// handlers tick only for direct field mutations that have no Store helper
// (PATCH repo/issue/comment/label, label removal). No Date.now(),
// no Math.random(), stdlib only, TypeScript strict.
//
// Field shapes were copied from program/env/src/checks-rest.ts (the check
// file wins over memory of the real GitHub API wherever they differ):
//   repos:    POST /user/repos 201; GET/PATCH /repos/{o}/{r}; DELETE 204;
//             GET /user/repos paginated via Link rel="next"; GET /branches,
//             GET /branches/{b}, GET /commits[?sha=], GET /commits/{sha},
//             PUT/GET/DELETE /contents/{path}, POST/GET /git/refs[/{ref}]
//   issues:   POST/GET /repos/{o}/{r}/issues, GET/PATCH /{n}, comments
//             POST/GET (+ PATCH/DELETE), labels GET/POST (+ per-issue add/remove)
//   pulls:    POST/GET /repos/{o}/{r}/pulls, GET /{n}, GET /{n}/files,
//             GET /{n}/reviews (empty), PUT /{n}/merge (squash)
//   protocol: GET /api/v3/ root + X-OAuth-Scopes, GET /api/v3/meta,
//             GET /api/v3/user, 401 {"message":"Bad credentials",...},
//             404 {"message":"Not Found"}, 400 malformed JSON, 422 unknown label.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, IssueComment, Label, Pull, Repo, Store, User } from './store.ts';
import {
  API_PREFIX,
  OAUTH_SCOPES,
  OAUTH_SCOPES_HEADER,
  REQUEST_ID_HEADER,
  badRequestBody,
  buildLinkHeader,
  conflictBody,
  isAuthed,
  methodNotAllowedBody,
  notFoundBody,
  originOf,
  paginate,
  parseJsonBody,
  parsePagination,
  unauthorizedBody,
  unprocessableBody,
  isJsonObject,
  type Ctx,
} from './protocol.ts';

// ---------------------------------------------------------------------------
// Small utilities

const SHA40_RE = /^[0-9a-f]{40}$/;
const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;

function isSha(value: string): boolean {
  return SHA40_RE.test(value);
}

/** Split a pathname into decoded segments, dropping empty pieces. */
function splitPath(path: string): string[] {
  const out: string[] = [];
  for (const piece of path.split('/')) {
    if (piece === '') continue;
    try {
      out.push(decodeURIComponent(piece));
    } catch {
      out.push(piece);
    }
  }
  return out;
}

function parseIntParam(value: string | null): number | null {
  if (value === null) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/** Epoch seconds for a Store.clock ISO string, computed without `new Date`. */
function epochOf(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(iso);
  if (m === null) return 0;
  return Math.floor(
    Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) / 1000,
  );
}

function base64Of(data: Buffer): string {
  return data.toString('base64');
}

function base64Decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** Split text into lines the way a diff counts them (no phantom last line). */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// ---------------------------------------------------------------------------
// JSON builders (fixed key order, GitHub-shaped; extra fields are allowed by
// the checks' shape assertions, missing required ones are not).

function userJson(user: User): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    avatar_url: user.avatar_url,
    html_url: user.html_url,
    type: user.type,
    site_admin: false,
    url: user.url,
  };
}

/** The viewer JSON never changes (scenario user, frozen); share one object per store. */
const viewerJsonCache = new WeakMap<Store, Record<string, unknown>>();

function viewerJson(store: Store): Record<string, unknown> {
  let cached = viewerJsonCache.get(store);
  if (cached === undefined) {
    cached = userJson(store.viewer);
    viewerJsonCache.set(store, cached);
  }
  return cached;
}

/** A user object for a login that may not be the viewer (issues/PRs are always the viewer's in practice). */
function userJsonFor(store: Store, login: string): Record<string, unknown> {
  if (login === store.viewer.login) return viewerJson(store);
  const known = store.users.get(login);
  if (known !== undefined) return userJson(known);
  return {
    login,
    id: 0,
    avatar_url: '',
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
    url: `/api/v3/users/${login}`,
  };
}

function repoUrl(owner: string, name: string): string {
  return `/api/v3/repos/${owner}/${name}`;
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  let openIssues = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') openIssues += 1;
  for (const pull of repo.pulls.values()) if (pull.state === 'open') openIssues += 1;
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    owner: userJsonFor(store, repo.owner),
    private: repo.private,
    html_url: `https://github.com/${repo.full_name}`,
    description: repo.description,
    fork: false,
    url: repoUrl(repo.owner, repo.name),
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.default_branch,
  };
}

function labelJson(label: Label, owner: string, repoName: string): Record<string, unknown> {
  return {
    id: label.id,
    url: `${repoUrl(owner, repoName)}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function issueLabelsJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const name of issue.labels) {
    const label = repo.labels.get(name);
    if (label !== undefined) out.push(labelJson(label, repo.owner, repo.name));
  }
  return out;
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const base = repoUrl(repo.owner, repo.name);
  return {
    id: issue.id,
    url: `${base}/issues/${issue.number}`,
    repository_url: base,
    labels_url: `${base}/issues/${issue.number}/labels{/name}`,
    comments_url: `${base}/issues/${issue.number}/comments`,
    events_url: `${base}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.full_name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: userJsonFor(store, issue.user),
    labels: issueLabelsJson(store, repo, issue),
    state: issue.state,
    locked: issue.locked,
    assignee: null,
    assignees: issue.assignees.map((login) => userJsonFor(store, login)),
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    author_association: issue.user === store.viewer.login ? 'OWNER' : 'NONE',
    active_lock_reason: null,
  };
}

function commentJson(store: Store, repo: Repo, issueNumber: number, comment: IssueComment): Record<string, unknown> {
  const base = repoUrl(repo.owner, repo.name);
  return {
    id: comment.id,
    url: `${base}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.full_name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJsonFor(store, comment.user),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    author_association: comment.user === store.viewer.login ? 'OWNER' : 'NONE',
  };
}

interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  oldSha: string | null;
  newSha: string | null;
}

function pullJson(
  store: Store,
  repo: Repo,
  pull: Pull,
  files: PullFile[] | null,
): Record<string, unknown> {
  const base = repoUrl(repo.owner, repo.name);
  const additions = files === null ? 0 : files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files === null ? 0 : files.reduce((sum, f) => sum + f.deletions, 0);
  const miniRepo = {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    owner: userJsonFor(store, repo.owner),
    private: repo.private,
    html_url: `https://github.com/${repo.full_name}`,
    description: repo.description,
    default_branch: repo.default_branch,
  };
  const headRepo = miniRepo;
  return {
    id: pull.id,
    url: `${base}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.full_name}/pull/${pull.number}`,
    diff_url: `https://github.com/${repo.full_name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.full_name}/pull/${pull.number}.patch`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJsonFor(store, pull.user),
    labels: [],
    locked: false,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.state === 'closed' ? (pull.merged_at ?? pull.updated_at) : null,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    merged: pull.merged,
    mergeable: pull.mergeable,
    mergeable_state: pull.merged ? 'unknown' : pull.mergeable ? 'clean' : 'dirty',
    draft: false,
    head: {
      label: pull.head.label,
      ref: pull.head.ref,
      sha: pull.head.sha,
      user: userJsonFor(store, repo.owner),
      repo: headRepo,
    },
    base: {
      label: pull.base.label,
      ref: pull.base.ref,
      sha: pull.base.sha,
      user: userJsonFor(store, repo.owner),
      repo: miniRepo,
    },
    commits: 1,
    additions,
    deletions,
    changed_files: files === null ? 0 : files.length,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    assignees: [],
    requested_reviewers: [],
  };
}

// ---------------------------------------------------------------------------
// Git objects (contents API + merges build real git objects through
// Store.putObject/getObject, so the git smart-HTTP surface can serve them).
// Object bytes follow git's format exactly; shas are sha1("<type> <len>\0"+data).

const ZERO_OID = '0000000000000000000000000000000000000000';

/** Store a git object in `repo` AND in the store-level map. git.ts reads
 * repo.objects only, so the repo-scoped write is mandatory; the store-level
 * write keeps the object visible to readers that look there (and mirrors
 * what graphql.ts's own writers do). Content-addressed, so dual-write is
 * idempotent. */
function putGitObject(store: Store, repo: Repo, type: 'blob' | 'tree' | 'commit' | 'tag', data: Buffer): string {
  const sha = store.putObject(type, data, repo);
  store.putObject(type, data);
  return sha;
}

/** Read an object: repo.objects first, then the store-level map (GraphQL's
 * writers are store-level only, so a merge committed through GraphQL must
 * still be readable here). Same order as graphql.ts's getObject helper. */
function getObj(
  store: Store,
  repo: Repo,
  sha: string,
): { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer } | undefined {
  return store.getObject(sha, repo) ?? store.getObject(sha);
}

/** Whether an object exists in either map. */
function hasObj(store: Store, repo: Repo, sha: string): boolean {
  return store.hasObject(sha, repo) || store.hasObject(sha);
}

interface TreeEntry {
  mode: string;
  name: string;
  sha: string; // 40 hex
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space === -1) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const mode = data.subarray(off, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    off = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitInfo {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorEpoch: number;
  committerName: string;
  committerEmail: string;
  committerEpoch: number;
  message: string;
}

function parsePerson(line: string): { name: string; email: string; epoch: number } {
  const m = /^(.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line);
  if (m === null) return { name: line, email: '', epoch: 0 };
  return { name: m[1] ?? '', email: m[2] ?? '', epoch: Number.parseInt(m[3] ?? '0', 10) };
}

function parseCommit(data: Buffer): CommitInfo | null {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  if (blank === -1) return null;
  const headerText = text.slice(0, blank);
  const message = text.slice(blank + 2).replace(/\n+$/, '');
  const info: CommitInfo = {
    tree: '',
    parents: [],
    authorName: '',
    authorEmail: '',
    authorEpoch: 0,
    committerName: '',
    committerEmail: '',
    committerEpoch: 0,
    message,
  };
  // Fold continuation lines (e.g. gpgsig) into the previous header.
  const lines: string[] = [];
  for (const raw of headerText.split('\n')) {
    if (raw.startsWith(' ') && lines.length > 0) {
      lines[lines.length - 1] += `\n${raw}`;
    } else {
      lines.push(raw);
    }
  }
  for (const line of lines) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const p = parsePerson(line.slice(7));
      info.authorName = p.name;
      info.authorEmail = p.email;
      info.authorEpoch = p.epoch;
    } else if (line.startsWith('committer ')) {
      const p = parsePerson(line.slice(10));
      info.committerName = p.name;
      info.committerEmail = p.email;
      info.committerEpoch = p.epoch;
    }
  }
  return info.tree === '' ? null : info;
}

function serializeCommit(info: CommitInfo): Buffer {
  let out = `tree ${info.tree}\n`;
  for (const parent of info.parents) out += `parent ${parent}\n`;
  out += `author ${info.authorName} <${info.authorEmail}> ${info.authorEpoch} +0000\n`;
  out += `committer ${info.committerName} <${info.committerEmail}> ${info.committerEpoch} +0000\n`;
  out += `\n${info.message}\n`;
  return Buffer.from(out, 'utf8');
}

/** ISO-8601 UTC string for epoch seconds, computed arithmetically (no Date object). */
function isoFromEpoch(epoch: number): string {
  const days = Math.floor(epoch / 86400);
  const secs = epoch - days * 86400;
  const hh = Math.floor(secs / 3600);
  const mm = Math.floor((secs - hh * 3600) / 60);
  const ss = secs - hh * 3600 - mm * 60;
  // Civil-from-days (Howard Hinnant's algorithm), deterministic.
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const mo = mp < 10 ? mp + 3 : mp - 9;
  const year = mo <= 2 ? y + 1 : y;
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${pad(year, 4)}-${pad(mo)}-${pad(d)}T${pad(hh)}:${pad(mm)}:${pad(ss)}.000Z`;
}

function commitJson(store: Store, repo: Repo, sha: string, info: CommitInfo): Record<string, unknown> {
  const authorUser =
    info.authorEmail === store.viewer.email ? userJson(store.viewer) : null;
  const committerUser =
    info.committerEmail === store.viewer.email ? userJson(store.viewer) : null;
  return {
    sha,
    url: `${repoUrl(repo.owner, repo.name)}/commits/${sha}`,
    html_url: `https://github.com/${repo.full_name}/commit/${sha}`,
    comments_url: `${repoUrl(repo.owner, repo.name)}/commits/${sha}/comments`,
    commit: {
      author: { name: info.authorName, email: info.authorEmail, date: isoFromEpoch(info.authorEpoch) },
      committer: { name: info.committerName, email: info.committerEmail, date: isoFromEpoch(info.committerEpoch) },
      message: info.message,
      tree: { sha: info.tree, url: `${repoUrl(repo.owner, repo.name)}/git/trees/${info.tree}` },
      url: `${repoUrl(repo.owner, repo.name)}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    author: authorUser,
    committer: committerUser,
    parents: info.parents.map((p) => ({
      sha: p,
      url: `${repoUrl(repo.owner, repo.name)}/commits/${p}`,
      html_url: `https://github.com/${repo.full_name}/commit/${p}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// Trees as file maps

interface FileEntry {
  sha: string;
  mode: string;
}

/** All files under a tree, as path -> blob. Returns an empty map for a null tree. */
function fileMapOf(store: Store, repo: Repo, treeSha: string | null, prefix: string, out: Map<string, FileEntry>): Map<string, FileEntry> {
  if (treeSha === null) return out;
  const obj = getObj(store, repo, treeSha);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      fileMapOf(store, repo, entry.sha, path, out);
    } else {
      out.set(path, { sha: entry.sha, mode: entry.mode });
    }
  }
  return out;
}

/**
 * Return a new tree sha with `path` set to `blobSha` (or removed when null),
 * starting from `baseTreeSha` (null = empty tree). Builds the nested trees
 * bottom-up through Store.putObject.
 */
function setPathInTree(
  store: Store,
  repo: Repo,
  baseTreeSha: string | null,
  parts: readonly string[],
  blobSha: string | null,
): string {
  const obj = baseTreeSha === null ? undefined : getObj(store, repo, baseTreeSha);
  const entries: TreeEntry[] =
    obj !== undefined && obj.type === 'tree' ? parseTree(obj.data) : [];
  const head = parts[0] as string;
  if (parts.length === 1) {
    const idx = entries.findIndex((e) => e.name === head);
    if (blobSha === null) {
      if (idx !== -1) entries.splice(idx, 1);
    } else if (idx !== -1) {
      entries[idx] = { mode: '100644', name: head, sha: blobSha };
    } else {
      entries.push({ mode: '100644', name: head, sha: blobSha });
    }
  } else {
    const idx = entries.findIndex((e) => e.name === head && e.mode === '40000');
    const childSha = idx === -1 ? null : entries[idx]!.sha;
    const next = setPathInTree(store, repo, childSha, parts.slice(1), blobSha);
    const nextObj = getObj(store, repo, next);
    const empty = nextObj !== undefined && nextObj.type === 'tree' && parseTree(nextObj.data).length === 0;
    if (empty) {
      if (idx !== -1) entries.splice(idx, 1);
    } else if (idx !== -1) {
      entries[idx] = { mode: '40000', name: head, sha: next };
    } else {
      entries.push({ mode: '40000', name: head, sha: next });
    }
  }
  return putGitObject(store, repo, 'tree', serializeTree(entries));
}

/** Build a whole tree from a file map (used for squash merges). */
function treeFromFileMap(store: Store, repo: Repo, files: Map<string, FileEntry>): string {
  const build = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const subdirs = new Map<string, Map<string, FileEntry>>();
    for (const [path, entry] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.push({ mode: entry.mode, name: rest, sha: entry.sha });
      } else {
        const dir = rest.slice(0, slash);
        let sub = subdirs.get(dir);
        if (sub === undefined) {
          sub = new Map();
          subdirs.set(dir, sub);
        }
        sub.set(path, entry);
      }
    }
    for (const [dir, sub] of subdirs) {
      entries.push({ mode: '40000', name: dir, sha: build(`${prefix}${dir}/`) });
      void sub;
    }
    return putGitObject(store, repo, 'tree', serializeTree(entries));
  };
  return build('');
}

/** Resolve a ref-ish to a commit sha: branch name, full ref, or 40-hex sha. */
function resolveRefToSha(store: Store, repo: Repo, ref: string): string | null {
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return direct;
  const headed = repo.refs.get(`refs/heads/${ref}`);
  if (headed !== undefined) return headed;
  if (isSha(ref)) {
    const obj = getObj(store, repo, ref);
    if (obj !== undefined && obj.type === 'commit') return ref;
  }
  return null;
}

/** Commit shas reachable from `tip`, newest first (DFS pre-order, first-parent first). */
function walkCommits(store: Store, repo: Repo, tip: string, max = 10000): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const stack: string[] = [tip];
  while (stack.length > 0 && out.length < max) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = getObj(store, repo, sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(sha);
    const info = parseCommit(obj.data);
    if (info === null) continue;
    for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i] as string);
  }
  return out;
}

/** The merge-base of two commits: the first commit reachable from `a` that is also reachable from `b`. */
function mergeBaseOf(store: Store, repo: Repo, a: string, b: string): string | null {
  const bAncestors = new Set(walkCommits(store, repo, b));
  for (const sha of walkCommits(store, repo, a)) {
    if (bAncestors.has(sha)) return sha;
  }
  return null;
}

/** LCS-based line counts for a file change (contents are small; DP is fine). */
function countLineChanges(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length * b.length > 250000) {
    // Fallback for unexpectedly large blobs: multiset difference.
    const bCount = new Map<string, number>();
    for (const line of b) bCount.set(line, (bCount.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of a) {
      const left = bCount.get(line) ?? 0;
      if (left > 0) {
        bCount.set(line, left - 1);
        common += 1;
      }
    }
    return { additions: b.length - common, deletions: a.length - common };
  }
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur.fill(0);
  }
  const lcs = prev[b.length] ?? 0;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

function blobTextOf(store: Store, repo: Repo, sha: string): string {
  const obj = getObj(store, repo, sha);
  if (obj === undefined || obj.type !== 'blob') return '';
  return obj.data.toString('utf8');
}

/** Diff two trees (base -> head) as pull-request file entries. */
function diffTrees(store: Store, repo: Repo, baseTree: string | null, headTree: string | null): PullFile[] {
  const base = fileMapOf(store, repo, baseTree, '', new Map());
  const head = fileMapOf(store, repo, headTree, '', new Map());
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const out: PullFile[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) {
      const counts = countLineChanges(blobTextOf(store, repo, b.sha), '');
      out.push({ filename: path, status: 'removed', additions: 0, deletions: counts.deletions, changes: counts.deletions, oldSha: b.sha, newSha: null });
    } else if (b === undefined && h !== undefined) {
      const counts = countLineChanges('', blobTextOf(store, repo, h.sha));
      out.push({ filename: path, status: 'added', additions: counts.additions, deletions: 0, changes: counts.additions, oldSha: null, newSha: h.sha });
    } else if (b !== undefined && h !== undefined && b.sha !== h.sha) {
      const counts = countLineChanges(blobTextOf(store, repo, b.sha), blobTextOf(store, repo, h.sha));
      out.push({
        filename: path,
        status: 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
        oldSha: b.sha,
        newSha: h.sha,
      });
    }
  }
  return out;
}

/** Would merging `headTip` into `baseTip` (merge-base `base`) conflict? */
function mergeWouldConflict(store: Store, repo: Repo, mergeBaseSha: string | null, headTip: string, baseTip: string): boolean {
  const baseInfo = mergeBaseSha === null ? null : getObj(store, repo, mergeBaseSha);
  const baseTree = baseInfo !== undefined && baseInfo !== null && baseInfo.type === 'commit' ? parseCommit(baseInfo.data)?.tree ?? null : null;
  const headInfo = getObj(store, repo, headTip);
  const headTree = headInfo !== undefined && headInfo.type === 'commit' ? parseCommit(headInfo.data)?.tree ?? null : null;
  const tipInfo = getObj(store, repo, baseTip);
  const tipTree = tipInfo !== undefined && tipInfo.type === 'commit' ? parseCommit(tipInfo.data)?.tree ?? null : null;
  const m = fileMapOf(store, repo, baseTree, '', new Map());
  const h = fileMapOf(store, repo, headTree, '', new Map());
  const t = fileMapOf(store, repo, tipTree, '', new Map());
  const paths = new Set<string>([...m.keys(), ...h.keys(), ...t.keys()]);
  for (const path of paths) {
    const mv = m.get(path)?.sha ?? null;
    const hv = h.get(path)?.sha ?? null;
    const tv = t.get(path)?.sha ?? null;
    if (hv !== mv && tv !== mv && hv !== tv) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Handler plumbing

interface BodyResult {
  ok: boolean;
  value: unknown;
}

class H {
  readonly store: Store;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly ctx: Ctx;
  readonly query: URLSearchParams;
  readonly method: string;
  private bodyCache: BodyResult | null = null;

  constructor(req: IncomingMessage, res: ServerResponse, ctx: Ctx & { store: Store }) {
    this.store = ctx.store;
    this.req = req;
    this.res = res;
    this.ctx = ctx;
    this.query = ctx.query;
    this.method = ctx.method;
  }

  json(status: number, body: unknown, headers: Record<string, string> = {}): void {
    this.ctx.json(status, body, headers);
  }

  noContent(status: number): void {
    this.res.writeHead(status, { [REQUEST_ID_HEADER]: this.ctx.requestId });
    this.res.end();
  }

  notFound(message = 'Not Found'): void {
    this.json(404, { message });
  }

  badRequest(message: string): void {
    this.json(400, badRequestBody(message));
  }

  unprocessable(message: string): void {
    this.json(422, unprocessableBody(message));
  }

  conflict(message: string): void {
    this.json(409, conflictBody(message));
  }

  methodNotAllowed(message: string): void {
    this.json(405, methodNotAllowedBody(message));
  }

  /** Current logical-clock time (no wall clock anywhere). */
  now(): string {
    return this.store.clock.nowIso();
  }

  /** Advance the logical clock once — called once per mutating operation. */
  tick(): void {
    this.store.clock.tick();
  }

  /** Read + parse the JSON body (once, cached). Malformed JSON answers 400. */
  async body(): Promise<BodyResult> {
    if (this.bodyCache !== null) return this.bodyCache;
    const buf = await this.ctx.readBody();
    const parsed = parseJsonBody(buf);
    if (!parsed.ok) {
      this.badRequest('Invalid JSON');
      this.bodyCache = { ok: false, value: undefined };
      return this.bodyCache;
    }
    this.bodyCache = { ok: true, value: parsed.empty ? {} : parsed.value };
    return this.bodyCache;
  }

  /** The body as a JSON object, or null (after answering 400/422 as needed). */
  async bodyObject(): Promise<Record<string, unknown> | null> {
    const result = await this.body();
    if (!result.ok) return null;
    if (!isJsonObject(result.value)) {
      this.badRequest('Request body must be a JSON object');
      return null;
    }
    return result.value;
  }

  /** Paginate a list, answering 200 with a Link header when there is more than one page. */
  pageList<T>(all: readonly T[], build: (item: T) => unknown): void {
    const params = parsePagination(this.query);
    const page = paginate(all, params);
    const link = buildLinkHeader(originOf(this.req), this.ctx.path, this.query, page);
    this.json(200, page.items.map(build), link === null ? {} : { link });
  }

  requireRepo(owner: string, name: string): Repo | null {
    const repo = this.store.getRepo(owner, name);
    if (repo === undefined) {
      this.notFound();
      return null;
    }
    return repo;
  }
}

function validRepoName(name: unknown): name is string {
  return typeof name === 'string' && name !== '' && name.length <= 100 && REPO_NAME_RE.test(name);
}

function stringField(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === 'string' ? value : null;
}

function boolField(body: Record<string, unknown>, field: string): boolean | null {
  const value = body[field];
  return typeof value === 'boolean' ? value : null;
}

function stringArrayField(body: Record<string, unknown>, field: string): string[] | null {
  const value = body[field];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else if (isJsonObject(item) && typeof item.name === 'string') out.push(item.name);
    else return null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Repositories

async function createRepoFor(h: H, owner: string): Promise<void> {
  const body = await h.bodyObject();
  if (body === null) return;
  const name = body.name;
  if (!validRepoName(name)) {
    h.unprocessable('Invalid repository name');
    return;
  }
  if (h.store.getRepo(owner, name) !== undefined) {
    h.unprocessable('Repository already exists');
    return;
  }
  const description = stringField(body, 'description') ?? '';
  const isPrivate = boolField(body, 'private') ?? false;
  const defaultBranch = stringField(body, 'default_branch') ?? 'main';
  const repo = h.store.createRepo(owner, name, {
    description,
    private: isPrivate,
    defaultBranch: defaultBranch === '' ? 'main' : defaultBranch,
  });
  h.json(201, repoJson(h.store, repo));
}

function listUserRepos(h: H): void {
  const viewer = h.store.viewer.login;
  const owned: Repo[] = [];
  for (const repo of h.store.repos.values()) {
    if (repo.owner === viewer) owned.push(repo);
  }
  h.pageList(owned, (repo) => repoJson(h.store, repo));
}

function patchRepo(h: H, repo: Repo, body: Record<string, unknown>): void {
  const description = stringField(body, 'description');
  if (description !== null) repo.description = description;
  const isPrivate = boolField(body, 'private');
  if (isPrivate !== null) repo.private = isPrivate;
  const branch = stringField(body, 'default_branch');
  if (branch !== null && branch !== '') repo.default_branch = branch;
  repo.updated_at = h.now();
  h.tick();
  h.json(200, repoJson(h.store, repo));
}

function deleteRepo(h: H, repo: Repo): void {
  h.store.deleteRepo(repo.owner, repo.name);
  h.noContent(204);
}

// ---------------------------------------------------------------------------
// Branches + commits

function listBranches(h: H, repo: Repo): void {
  const out: Record<string, unknown>[] = [];
  for (const [ref, sha] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    const name = ref.slice('refs/heads/'.length);
    out.push({
      name,
      commit: { sha, url: `${repoUrl(repo.owner, repo.name)}/commits/${sha}` },
      protected: false,
    });
  }
  h.json(200, out);
}

function getBranch(h: H, repo: Repo, name: string): void {
  const sha = repo.refs.get(`refs/heads/${name}`);
  if (sha === undefined) {
    h.notFound('Branch not found');
    return;
  }
  h.json(200, {
    name,
    commit: { sha, url: `${repoUrl(repo.owner, repo.name)}/commits/${sha}` },
    protected: false,
  });
}

function listCommits(h: H, repo: Repo): void {
  const ref = h.query.get('sha') ?? repo.default_branch;
  const tip = resolveRefToSha(h.store, repo, ref);
  if (tip === null) {
    if (repo.refs.size === 0) {
      h.json(200, []);
      return;
    }
    h.notFound('No commit found for SHA');
    return;
  }
  const shas = walkCommits(h.store, repo, tip);
  const items: Record<string, unknown>[] = [];
  for (const sha of shas) {
    const obj = getObj(h.store, repo, sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    if (info === null) continue;
    items.push(commitJson(h.store, repo, sha, info));
  }
  h.pageList(items, (item) => item);
}

function getCommit(h: H, repo: Repo, ref: string): void {
  const sha = resolveRefToSha(h.store, repo, ref);
  if (sha === null) {
    h.notFound('No commit found for SHA');
    return;
  }
  const obj = getObj(h.store, repo, sha);
  if (obj === undefined || obj.type !== 'commit') {
    h.notFound('No commit found for SHA');
    return;
  }
  const info = parseCommit(obj.data);
  if (info === null) {
    h.notFound('No commit found for SHA');
    return;
  }
  h.json(200, commitJson(h.store, repo, sha, info));
}

// ---------------------------------------------------------------------------
// Contents (real git objects: blob + trees + commit per write)

function contentsFileJson(
  h: H,
  repo: Repo,
  path: string,
  blobSha: string,
  data: Buffer,
): Record<string, unknown> {
  const base = repoUrl(repo.owner, repo.name);
  const name = path.slice(path.lastIndexOf('/') + 1);
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    content: base64Of(data),
    sha: blobSha,
    url: `${base}/contents/${path}`,
    git_url: `${base}/git/blobs/${blobSha}`,
    html_url: `https://github.com/${repo.full_name}/blob/${repo.default_branch}/${path}`,
    download_url: null,
    _links: {
      git: `${base}/git/blobs/${blobSha}`,
      html: `https://github.com/${repo.full_name}/blob/${repo.default_branch}/${path}`,
      self: `${base}/contents/${path}`,
    },
  };
}

/** The tree sha of a directory path inside a tree (null when absent). */
function treeShaAtPath(store: Store, repo: Repo, treeSha: string | null, dirPath: string): string | null {
  if (dirPath === '') return treeSha;
  const obj = treeSha === null ? undefined : getObj(store, repo, treeSha);
  if (obj === undefined || obj.type !== 'tree') return null;
  const parts = dirPath.split('/');
  let current: TreeEntry[] = parseTree(obj.data);
  let found: string | null = null;
  for (const part of parts) {
    const entry = current.find((e) => e.name === part && e.mode === '40000');
    if (entry === undefined) return null;
    found = entry.sha;
    const child = getObj(store, repo, entry.sha);
    if (child === undefined || child.type !== 'tree') return null;
    current = parseTree(child.data);
  }
  return found;
}

function contentsGet(h: H, repo: Repo, filePath: string): void {
  const ref = h.query.get('ref') ?? repo.default_branch;
  const tip = resolveRefToSha(h.store, repo, ref);
  if (tip === null) {
    h.notFound();
    return;
  }
  const tipObj = getObj(h.store, repo, tip);
  if (tipObj === undefined || tipObj.type !== 'commit') {
    h.notFound();
    return;
  }
  const tipInfo = parseCommit(tipObj.data);
  if (tipInfo === null) {
    h.notFound();
    return;
  }
  const files = fileMapOf(h.store, repo, tipInfo.tree, '', new Map());
  if (filePath === '') {
    // Root directory listing.
    const entries = directoryEntries(h, repo, files, '', tipInfo.tree);
    h.json(200, entries);
    return;
  }
  const entry = files.get(filePath);
  if (entry !== undefined) {
    const obj = getObj(h.store, repo, entry.sha);
    const data = obj !== undefined && obj.type === 'blob' ? obj.data : Buffer.alloc(0);
    h.json(200, contentsFileJson(h, repo, filePath, entry.sha, data));
    return;
  }
  // A directory: immediate children of filePath.
  const prefix = `${filePath}/`;
  let any = false;
  for (const path of files.keys()) {
    if (path.startsWith(prefix)) {
      any = true;
      break;
    }
  }
  if (!any) {
    h.notFound();
    return;
  }
  const dirTree = treeShaAtPath(h.store, repo, tipInfo.tree, filePath);
  h.json(200, directoryEntries(h, repo, files, filePath, dirTree));
}

/** Immediate children of a directory path, as GitHub contents entries. */
function directoryEntries(
  h: H,
  repo: Repo,
  files: Map<string, FileEntry>,
  dirPath: string,
  dirTree: string | null,
): Record<string, unknown>[] {
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  const seen = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      const obj = getObj(h.store, repo, entry.sha);
      seen.set(rest, {
        type: 'file',
        sha: entry.sha,
        size: obj !== undefined && obj.type === 'blob' ? obj.data.length : 0,
      });
    } else {
      const dir = rest.slice(0, slash);
      if (!seen.has(dir)) {
        const sha = treeShaAtPath(h.store, repo, dirTree, dir) ?? '';
        seen.set(dir, { type: 'dir', sha, size: 0 });
      }
    }
  }
  const base = repoUrl(repo.owner, repo.name);
  const out: Record<string, unknown>[] = [];
  for (const name of [...seen.keys()].sort()) {
    const info = seen.get(name) as { type: 'file' | 'dir'; sha: string; size: number };
    const path = prefix + name;
    out.push({
      type: info.type,
      size: info.size,
      name,
      path,
      sha: info.sha,
      url: `${base}/contents/${path}`,
      git_url: `${base}/git/${info.type === 'dir' ? 'trees' : 'blobs'}/${info.sha}`,
      html_url: `https://github.com/${repo.full_name}/${info.type === 'dir' ? 'tree' : 'blob'}/${repo.default_branch}/${path}`,
      download_url: info.type === 'file' ? null : null,
    });
  }
  return out;
}

async function contentsPut(h: H, repo: Repo, filePath: string): Promise<void> {
  const body = await h.bodyObject();
  if (body === null) return;
  const message = stringField(body, 'message');
  if (message === null || message === '') {
    h.unprocessable('message is required');
    return;
  }
  const contentB64 = stringField(body, 'content');
  if (contentB64 === null) {
    h.unprocessable('content is required');
    return;
  }
  const branch = stringField(body, 'branch') ?? repo.default_branch;
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  if (tip === undefined && repo.refs.size > 0) {
    h.notFound('Branch not found');
    return;
  }
  let baseTree: string | null = null;
  if (tip !== undefined) {
    const tipObj = getObj(h.store, repo, tip);
    const tipInfo = tipObj !== undefined && tipObj.type === 'commit' ? parseCommit(tipObj.data) : null;
    if (tipInfo === null) {
      h.notFound('Branch not found');
      return;
    }
    baseTree = tipInfo.tree;
  }
  const files = fileMapOf(h.store, repo, baseTree, '', new Map());
  const current = files.get(filePath);
  const sha = stringField(body, 'sha');
  if (sha !== undefined && sha !== null) {
    if (current === undefined || sha.toLowerCase() !== current.sha.toLowerCase()) {
      h.conflict('The sha does not match the current blob');
      return;
    }
  } else if (current !== undefined) {
    h.unprocessable('File already exists');
    return;
  }
  const data = base64Decode(contentB64);
  const blobSha = putGitObject(h.store, repo, 'blob', data);
  const newTree = setPathInTree(h.store, repo, baseTree, filePath.split('/'), blobSha);
  const now = h.now();
  const epoch = epochOf(now);
  const viewer = h.store.viewer;
  const commitSha = putGitObject(
    h.store,
    repo,
    'commit',
    serializeCommit({
      tree: newTree,
      parents: tip === undefined ? [] : [tip],
      authorName: viewer.name,
      authorEmail: viewer.email,
      authorEpoch: epoch,
      committerName: viewer.name,
      committerEmail: viewer.email,
      committerEpoch: epoch,
      message,
    }),
  );
  // updateRef stamps pushed_at/updated_at, bumps repo.version and ticks once.
  const updated = h.store.updateRef(repo, refName, commitSha, tip === undefined ? ZERO_OID : tip);
  if (!updated.ok) {
    h.conflict(updated.reason);
    return;
  }
  const commitObj = getObj(h.store, repo, commitSha);
  const commitInfo = commitObj !== undefined ? parseCommit(commitObj.data) : null;
  h.json(current === undefined ? 201 : 200, {
    content: contentsFileJson(h, repo, filePath, blobSha, data),
    commit:
      commitInfo === null
        ? { sha: commitSha }
        : commitJson(h.store, repo, commitSha, commitInfo),
  });
}

async function contentsDelete(h: H, repo: Repo, filePath: string): Promise<void> {
  const body = await h.bodyObject();
  if (body === null) return;
  const message = stringField(body, 'message');
  if (message === null || message === '') {
    h.unprocessable('message is required');
    return;
  }
  const sha = stringField(body, 'sha');
  if (sha === null || sha === '') {
    h.unprocessable('sha is required');
    return;
  }
  const branch = stringField(body, 'branch') ?? repo.default_branch;
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  if (tip === undefined) {
    h.notFound('Branch not found');
    return;
  }
  const tipObj = getObj(h.store, repo, tip);
  const tipInfo = tipObj !== undefined && tipObj.type === 'commit' ? parseCommit(tipObj.data) : null;
  if (tipInfo === null) {
    h.notFound('Branch not found');
    return;
  }
  const files = fileMapOf(h.store, repo, tipInfo.tree, '', new Map());
  const current = files.get(filePath);
  if (current === undefined) {
    h.notFound();
    return;
  }
  if (sha.toLowerCase() !== current.sha.toLowerCase()) {
    h.conflict('The sha does not match the current blob');
    return;
  }
  const newTree = setPathInTree(h.store, repo, tipInfo.tree, filePath.split('/'), null);
  const now = h.now();
  const epoch = epochOf(now);
  const viewer = h.store.viewer;
  const commitSha = putGitObject(
    h.store,
    repo,
    'commit',
    serializeCommit({
      tree: newTree,
      parents: [tip],
      authorName: viewer.name,
      authorEmail: viewer.email,
      authorEpoch: epoch,
      committerName: viewer.name,
      committerEmail: viewer.email,
      committerEpoch: epoch,
      message,
    }),
  );
  const updated = h.store.updateRef(repo, refName, commitSha, tip);
  if (!updated.ok) {
    h.conflict(updated.reason);
    return;
  }
  const commitObj = getObj(h.store, repo, commitSha);
  const commitInfo = commitObj !== undefined ? parseCommit(commitObj.data) : null;
  h.json(200, {
    content: null,
    commit: commitInfo === null ? { sha: commitSha } : commitJson(h.store, repo, commitSha, commitInfo),
  });
}

// ---------------------------------------------------------------------------
// Git refs (REST git-data surface the checks + MCP setup use)

function refJson(h: H, repo: Repo, ref: string, sha: string): Record<string, unknown> {
  const obj = getObj(h.store, repo, sha);
  const type = obj === undefined ? 'commit' : obj.type;
  const base = repoUrl(repo.owner, repo.name);
  return {
    ref,
    url: `${base}/git/refs/${ref}`,
    object: { sha, type, url: `${base}/git/${type}s/${sha}` },
  };
}

async function refsCreate(h: H, repo: Repo): Promise<void> {
  const body = await h.bodyObject();
  if (body === null) return;
  const ref = stringField(body, 'ref');
  const sha = stringField(body, 'sha');
  if (ref === null || !ref.startsWith('refs/') || sha === null || !isSha(sha)) {
    h.unprocessable('Invalid ref or sha');
    return;
  }
  if (!hasObj(h.store, repo, sha)) {
    h.unprocessable('Invalid sha');
    return;
  }
  if (repo.refs.has(ref)) {
    h.unprocessable('Reference already exists');
    return;
  }
  const updated = h.store.updateRef(repo, ref, sha, ZERO_OID);
  if (!updated.ok) {
    h.unprocessable(updated.reason);
    return;
  }
  h.json(201, refJson(h, repo, ref, sha));
}

function refsList(h: H, repo: Repo): void {
  const out: Record<string, unknown>[] = [];
  for (const [ref, sha] of repo.refs) out.push(refJson(h, repo, ref, sha));
  h.json(200, out);
}

function refsGet(h: H, repo: Repo, ref: string): void {
  const sha = repo.refs.get(ref);
  if (sha === undefined) {
    h.notFound('Reference not found');
    return;
  }
  h.json(200, refJson(h, repo, ref, sha));
}

async function refsPatch(h: H, repo: Repo, ref: string): Promise<void> {
  const body = await h.bodyObject();
  if (body === null) return;
  const sha = stringField(body, 'sha');
  if (sha === null || !isSha(sha)) {
    h.unprocessable('Invalid sha');
    return;
  }
  if (!repo.refs.has(ref)) {
    h.notFound('Reference not found');
    return;
  }
  if (!hasObj(h.store, repo, sha)) {
    h.unprocessable('Invalid sha');
    return;
  }
  // PATCH is a force-capable update: no fast-forward requirement.
  repo.refs.set(ref, sha);
  repo.version += 1;
  repo.updated_at = h.now();
  repo.pushed_at = repo.updated_at;
  h.tick();
  h.json(200, refJson(h, repo, ref, sha));
}

// ---------------------------------------------------------------------------
// Labels

function listLabels(h: H, repo: Repo): void {
  h.pageList([...repo.labels.values()], (label) => labelJson(label, repo.owner, repo.name));
}

async function createLabel(h: H, repo: Repo): Promise<void> {
  const body = await h.bodyObject();
  if (body === null) return;
  const name = stringField(body, 'name');
  if (name === null || name === '') {
    h.unprocessable('name is required');
    return;
  }
  if (repo.labels.has(name)) {
    h.unprocessable('Label already exists');
    return;
  }
  const colorRaw = stringField(body, 'color') ?? 'ededed';
  const color = colorRaw.startsWith('#') ? colorRaw.slice(1) : colorRaw;
  const label = h.store.createLabel(repo, name, color, stringField(body, 'description') ?? '');
  h.json(201, labelJson(label, repo.owner, repo.name));
}

function getLabel(h: H, repo: Repo, name: string): void {
  const label = repo.labels.get(name);
  if (label === undefined) {
    h.notFound('Label not found');
    return;
  }
  h.json(200, labelJson(label, repo.owner, repo.name));
}

async function patchLabel(h: H, repo: Repo, name: string): Promise<void> {
  const label = repo.labels.get(name);
  if (label === undefined) {
    h.notFound('Label not found');
    return;
  }
  const body = await h.bodyObject();
  if (body === null) return;
  const newName = stringField(body, 'new_name');
  const color = stringField(body, 'color');
  const description = stringField(body, 'description');
  if (color !== null) label.color = color.startsWith('#') ? color.slice(1) : color;
  if (description !== null) label.description = description;
  if (newName !== null && newName !== '' && newName !== name) {
    if (repo.labels.has(newName)) {
      h.unprocessable('Label already exists');
      return;
    }
    repo.labels.delete(name);
    label.name = newName;
    repo.labels.set(newName, label);
  }
  h.tick();
  h.json(200, labelJson(label, repo.owner, repo.name));
}

function deleteLabel(h: H, repo: Repo, name: string): void {
  if (!repo.labels.has(name)) {
    h.notFound('Label not found');
    return;
  }
  repo.labels.delete(name);
  h.tick();
  h.noContent(204);
}

// ---------------------------------------------------------------------------
// Issues + comments

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function listIssues(h: H, repo: Repo): void {
  const state = h.query.get('state') ?? 'open';
  const labelsParam = h.query.get('labels');
  const wantedLabels = labelsParam === null || labelsParam === '' ? [] : labelsParam.split(',');
  const sort = h.query.get('sort') ?? 'created';
  const direction = h.query.get('direction') ?? 'desc';
  let items = [...repo.issues.values()];
  if (state !== 'all') items = items.filter((issue) => issue.state === state);
  if (wantedLabels.length > 0) {
    items = items.filter((issue) => wantedLabels.every((label) => issue.labels.includes(label)));
  }
  const keyOf = (issue: Issue): string | number => {
    if (sort === 'updated') return issue.updated_at;
    if (sort === 'comments') return issue.comments.length;
    return issue.created_at;
  };
  items.sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    const cmp = typeof ka === 'number' && typeof kb === 'number' ? ka - kb : compareText(String(ka), String(kb));
    if (cmp !== 0) return direction === 'asc' ? cmp : -cmp;
    return direction === 'asc' ? a.number - b.number : b.number - a.number;
  });
  h.pageList(items, (issue) => issueJson(h.store, repo, issue));
}

async function createIssue(h: H, repo: Repo): Promise<void> {
  const body = await h.bodyObject();
  if (body === null) return;
  const title = stringField(body, 'title');
  if (title === null || title === '') {
    h.unprocessable('title is required');
    return;
  }
  const labels = stringArrayField(body, 'labels') ?? [];
  for (const name of labels) {
    if (!repo.labels.has(name)) {
      h.unprocessable(`Label "${name}" does not exist`);
      return;
    }
  }
  const assignees = stringArrayField(body, 'assignees') ?? [];
  const issue = h.store.createIssue(repo, {
    title,
    body: stringField(body, 'body') ?? '',
    labels: [...new Set(labels)],
    assignees,
  });
  h.json(201, issueJson(h.store, repo, issue));
}

function issueByNumber(h: H, repo: Repo, raw: string): Issue | null {
  const number = parseIntParam(raw);
  if (number === null) {
    h.notFound();
    return null;
  }
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    h.notFound();
    return null;
  }
  return issue;
}

async function patchIssue(h: H, repo: Repo, issue: Issue): Promise<void> {
  const body = await h.bodyObject();
  if (body === null) return;
  const title = stringField(body, 'title');
  if (title !== null) issue.title = title;
  const text = stringField(body, 'body');
  if (text !== null) issue.body = text;
  const locked = boolField(body, 'locked');
  if (locked !== null) issue.locked = locked;
  const labels = stringArrayField(body, 'labels');
  if (labels !== null) {
    for (const name of labels) {
      if (!repo.labels.has(name)) {
        h.unprocessable(`Label "${name}" does not exist`);
        return;
      }
    }
    issue.labels = [...new Set(labels)];
  }
  const assignees = stringArrayField(body, 'assignees');
  if (assignees !== null) issue.assignees = assignees;
  const state = stringField(body, 'state');
  if (state !== null) {
    if (state !== 'open' && state !== 'closed') {
      h.unprocessable('Invalid state');
      return;
    }
    if (state !== issue.state) {
      issue.state = state as 'open' | 'closed';
      issue.closed_at = state === 'closed' ? h.now() : null;
    }
  }
  issue.updated_at = h.now();
  h.tick();
  h.json(200, issueJson(h.store, repo, issue));
}

function listComments(h: H, repo: Repo, issue: Issue): void {
  h.pageList(issue.comments, (comment) => commentJson(h.store, repo, issue.number, comment));
}

async function createComment(h: H, repo: Repo, issue: Issue): Promise<void> {
  const body = await h.bodyObject();
  if (body === null) return;
  const text = stringField(body, 'body');
  if (text === null || text === '') {
    h.unprocessable('body is required');
    return;
  }
  const comment = h.store.addIssueComment(repo, issue.number, text);
  if (comment === undefined) {
    h.notFound();
    return;
  }
  h.json(201, commentJson(h.store, repo, issue.number, comment));
}

function findComment(repo: Repo, id: number): { issue: Issue; index: number; comment: IssueComment } | null {
  for (const issue of repo.issues.values()) {
    const index = issue.comments.findIndex((c) => c.id === id);
    if (index !== -1) {
      return { issue, index, comment: issue.comments[index] as IssueComment };
    }
  }
  return null;
}

function getComment(h: H, repo: Repo, idRaw: string): void {
  const id = parseIntParam(idRaw);
  if (id === null) {
    h.notFound();
    return;
  }
  const found = findComment(repo, id);
  if (found === null) {
    h.notFound();
    return;
  }
  h.json(200, commentJson(h.store, repo, found.issue.number, found.comment));
}

async function patchComment(h: H, repo: Repo, idRaw: string, scopeIssue?: Issue): Promise<void> {
  const id = parseIntParam(idRaw);
  if (id === null) {
    h.notFound();
    return;
  }
  const found =
    scopeIssue === undefined
      ? findComment(repo, id)
      : (() => {
          const index = scopeIssue.comments.findIndex((c) => c.id === id);
          return index === -1 ? null : { issue: scopeIssue, index, comment: scopeIssue.comments[index] as IssueComment };
        })();
  if (found === null) {
    h.notFound();
    return;
  }
  const body = await h.bodyObject();
  if (body === null) return;
  const text = stringField(body, 'body');
  if (text === null || text === '') {
    h.unprocessable('body is required');
    return;
  }
  found.comment.body = text;
  found.comment.updated_at = h.now();
  h.tick();
  h.json(200, commentJson(h.store, repo, found.issue.number, found.comment));
}

function deleteComment(h: H, repo: Repo, idRaw: string, scopeIssue?: Issue): void {
  const id = parseIntParam(idRaw);
  if (id === null) {
    h.notFound();
    return;
  }
  const found =
    scopeIssue === undefined
      ? findComment(repo, id)
      : (() => {
          const index = scopeIssue.comments.findIndex((c) => c.id === id);
          return index === -1 ? null : { issue: scopeIssue, index, comment: scopeIssue.comments[index] as IssueComment };
        })();
  if (found === null) {
    h.notFound();
    return;
  }
  found.issue.comments.splice(found.index, 1);
  h.tick();
  h.noContent(204);
}

function listIssueLabels(h: H, repo: Repo, issue: Issue): void {
  h.json(200, issueLabelsJson(h.store, repo, issue));
}

async function addIssueLabels(h: H, repo: Repo, issue: Issue): Promise<void> {
  const result = await h.body();
  if (!result.ok) return;
  let names: string[] | null = null;
  if (Array.isArray(result.value)) {
    names = [];
    for (const item of result.value) {
      if (typeof item === 'string') names.push(item);
      else if (isJsonObject(item) && typeof item.name === 'string') names.push(item.name);
      else {
        h.unprocessable('Invalid label');
        return;
      }
    }
  } else if (isJsonObject(result.value)) {
    names = stringArrayField(result.value, 'labels');
  }
  if (names === null) {
    h.unprocessable('labels is required');
    return;
  }
  for (const name of names) {
    if (!repo.labels.has(name)) {
      h.unprocessable(`Label "${name}" does not exist`);
      return;
    }
  }
  for (const name of names) {
    if (!issue.labels.includes(name)) issue.labels.push(name);
  }
  issue.updated_at = h.now();
  h.tick();
  h.json(200, issueLabelsJson(h.store, repo, issue));
}

function removeIssueLabel(h: H, repo: Repo, issue: Issue, name: string): void {
  const idx = issue.labels.indexOf(name);
  if (idx === -1) {
    h.notFound('Label not found on this issue');
    return;
  }
  issue.labels.splice(idx, 1);
  issue.updated_at = h.now();
  h.tick();
  h.json(200, issueLabelsJson(h.store, repo, issue));
}

// ---------------------------------------------------------------------------
// Pull requests

function treeShaOfCommit(store: Store, repo: Repo, sha: string): string | null {
  const obj = getObj(store, repo, sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data)?.tree ?? null;
}

/** The files a pull request changes (merge-base tree -> head tree). */
function prFiles(h: H, repo: Repo, pull: Pull): PullFile[] {
  const headTree = treeShaOfCommit(h.store, repo, pull.head.sha);
  const mb = mergeBaseOf(h.store, repo, pull.head.sha, pull.base.sha);
  const baseTree = mb === null ? treeShaOfCommit(h.store, repo, pull.base.sha) : treeShaOfCommit(h.store, repo, mb);
  return diffTrees(h.store, repo, baseTree, headTree);
}

function pullMergeable(h: H, repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
  if (baseTip === undefined) return false;
  const mb = mergeBaseOf(h.store, repo, pull.head.sha, baseTip);
  if (mb === null) return false;
  return !mergeWouldConflict(h.store, repo, mb, pull.head.sha, baseTip);
}

function listPulls(h: H, repo: Repo): void {
  const state = h.query.get('state') ?? 'open';
  let items = [...repo.pulls.values()];
  if (state !== 'all') items = items.filter((pull) => pull.state === state);
  items.sort((a, b) => {
    const cmp = compareText(a.created_at, b.created_at);
    return cmp !== 0 ? -cmp : b.number - a.number;
  });
  h.pageList(items, (pull) => pullJson(h.store, repo, { ...pull, mergeable: pullMergeable(h, repo, pull) }, null));
}

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}

async function createPull(h: H, repo: Repo): Promise<void> {
  const body = await h.bodyObject();
  if (body === null) return;
  const title = stringField(body, 'title');
  if (title === null || title === '') {
    h.unprocessable('title is required');
    return;
  }
  const headRaw = stringField(body, 'head');
  const baseRaw = stringField(body, 'base');
  if (headRaw === null || headRaw === '' || baseRaw === null || baseRaw === '') {
    h.unprocessable('head and base are required');
    return;
  }
  const head = stripOwnerPrefix(headRaw);
  const base = stripOwnerPrefix(baseRaw);
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (headTip === undefined) {
    h.unprocessable('Invalid head branch');
    return;
  }
  if (baseTip === undefined) {
    h.unprocessable('Invalid base branch');
    return;
  }
  const pull = h.store.createPull(repo, {
    title,
    body: stringField(body, 'body') ?? '',
    head: { label: `${repo.owner}:${head}`, ref: head, sha: headTip },
    base: { label: `${repo.owner}:${base}`, ref: base, sha: baseTip },
  });
  const mb = mergeBaseOf(h.store, repo, headTip, baseTip);
  pull.mergeable = mb !== null && !mergeWouldConflict(h.store, repo, mb, headTip, baseTip);
  h.json(201, pullJson(h.store, repo, pull, null));
}

function pullByNumber(h: H, repo: Repo, raw: string): Pull | null {
  const number = parseIntParam(raw);
  if (number === null) {
    h.notFound();
    return null;
  }
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    h.notFound();
    return null;
  }
  return pull;
}

function getPull(h: H, repo: Repo, pull: Pull): void {
  const files = prFiles(h, repo, pull);
  h.json(200, pullJson(h.store, repo, { ...pull, mergeable: pullMergeable(h, repo, pull) }, files));
}

function listPullFiles(h: H, repo: Repo, pull: Pull): void {
  const files = prFiles(h, repo, pull);
  h.json(
    200,
    files.map((f) => ({
      sha: f.newSha ?? f.oldSha ?? '',
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      blob_url: `${repoUrl(repo.owner, repo.name)}/git/blobs/${f.newSha ?? f.oldSha ?? ''}`,
      raw_url: `https://github.com/${repo.full_name}/raw/${pull.head.ref}/${f.filename}`,
      contents_url: `${repoUrl(repo.owner, repo.name)}/contents/${f.filename}`,
    })),
  );
}

function listPullCommits(h: H, repo: Repo, pull: Pull): void {
  const mb = mergeBaseOf(h.store, repo, pull.head.sha, pull.base.sha);
  const shas = walkCommits(h.store, repo, pull.head.sha);
  const items: Record<string, unknown>[] = [];
  for (const sha of shas) {
    if (mb !== null && sha === mb) break;
    const obj = getObj(h.store, repo, sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    if (info === null) continue;
    items.push(commitJson(h.store, repo, sha, info));
  }
  h.json(200, items);
}

async function mergePull(h: H, repo: Repo, pull: Pull): Promise<void> {
  const body = await h.bodyObject();
  if (body === null) return;
  if (pull.merged) {
    h.methodNotAllowed('Pull request already merged');
    return;
  }
  if (pull.state === 'closed') {
    h.methodNotAllowed('Pull request is closed');
    return;
  }
  const baseRef = `refs/heads/${pull.base.ref}`;
  const baseTip = repo.refs.get(baseRef);
  if (baseTip === undefined) {
    h.methodNotAllowed('Base branch not found');
    return;
  }
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  const mb = mergeBaseOf(h.store, repo, headTip, baseTip);
  if (mb === null) {
    h.methodNotAllowed('No merge base found');
    return;
  }
  if (mergeWouldConflict(h.store, repo, mb, headTip, baseTip)) {
    h.methodNotAllowed('Merge conflict');
    return;
  }
  // Squash: apply the head-vs-merge-base changes onto the current base tip tree.
  const mbTree = treeShaOfCommit(h.store, repo, mb);
  const headTree = treeShaOfCommit(h.store, repo, headTip);
  const baseTree = treeShaOfCommit(h.store, repo, baseTip);
  const changes = diffTrees(h.store, repo, mbTree, headTree);
  const merged = fileMapOf(h.store, repo, baseTree, '', new Map());
  for (const change of changes) {
    if (change.status === 'removed') merged.delete(change.filename);
    else if (change.newSha !== null) merged.set(change.filename, { sha: change.newSha, mode: '100644' });
  }
  const mergedTree = treeFromFileMap(h.store, repo, merged);
  const now = h.now();
  const epoch = epochOf(now);
  const viewer = h.store.viewer;
  const commitTitle =
    stringField(body, 'commit_title') ?? `Merge pull request #${pull.number} from ${repo.owner}/${pull.head.ref}`;
  const commitMessage = stringField(body, 'commit_message');
  const message = commitMessage === null ? commitTitle : `${commitTitle}\n\n${commitMessage}`;
  const mergeSha = putGitObject(
    h.store,
    repo,
    'commit',
    serializeCommit({
      tree: mergedTree,
      parents: [baseTip],
      authorName: viewer.name,
      authorEmail: viewer.email,
      authorEpoch: epoch,
      committerName: viewer.name,
      committerEmail: viewer.email,
      committerEpoch: epoch,
      message,
    }),
  );
  const updated = h.store.updateRef(repo, baseRef, mergeSha, baseTip);
  if (!updated.ok) {
    h.conflict(updated.reason);
    return;
  }
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = now;
  pull.merge_commit_sha = mergeSha;
  pull.updated_at = now;
  h.json(200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
}

// ---------------------------------------------------------------------------
// Dispatch (O(1)-ish: a decision tree over path segments, no regex, no
// per-request route-table allocation) + the exported handler.

async function dispatchRepos(h: H, owner: string, name: string, rest: string[]): Promise<void> {
  const repo = h.requireRepo(owner, name);
  if (repo === null) return;
  const method = h.method;
  const head = rest[0];

  if (rest.length === 0) {
    if (method === 'GET') h.json(200, repoJson(h.store, repo));
    else if (method === 'PATCH') {
      const body = await h.bodyObject();
      if (body !== null) patchRepo(h, repo, body);
    } else if (method === 'DELETE') deleteRepo(h, repo);
    else h.notFound();
    return;
  }

  if (head === 'branches') {
    if (rest.length === 1) {
      if (method === 'GET') listBranches(h, repo);
      else h.notFound();
    } else if (method === 'GET') getBranch(h, repo, rest.slice(1).join('/'));
    else h.notFound();
    return;
  }

  if (head === 'commits') {
    if (rest.length === 1) {
      if (method === 'GET') listCommits(h, repo);
      else h.notFound();
    } else if (rest.length === 2 && method === 'GET') getCommit(h, repo, rest[1] as string);
    else h.notFound();
    return;
  }

  if (head === 'contents') {
    const filePath = rest.slice(1).join('/');
    if (method === 'GET') contentsGet(h, repo, filePath);
    else if (method === 'PUT') await contentsPut(h, repo, filePath);
    else if (method === 'DELETE') await contentsDelete(h, repo, filePath);
    else h.notFound();
    return;
  }

  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2) {
      if (method === 'GET') refsList(h, repo);
      else if (method === 'POST') await refsCreate(h, repo);
      else h.notFound();
    } else if (rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      if (method === 'GET') refsGet(h, repo, ref);
      else if (method === 'PATCH') await refsPatch(h, repo, ref);
      else h.notFound();
    } else h.notFound();
    return;
  }

  if (head === 'labels') {
    if (rest.length === 1) {
      if (method === 'GET') listLabels(h, repo);
      else if (method === 'POST') await createLabel(h, repo);
      else h.notFound();
    } else if (rest.length === 2) {
      const labelName = rest[1] as string;
      if (method === 'GET') getLabel(h, repo, labelName);
      else if (method === 'PATCH') await patchLabel(h, repo, labelName);
      else if (method === 'DELETE') deleteLabel(h, repo, labelName);
      else h.notFound();
    } else h.notFound();
    return;
  }

  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') listIssues(h, repo);
      else if (method === 'POST') await createIssue(h, repo);
      else h.notFound();
      return;
    }
    // Canonical single-comment routes: /issues/comments/{id}
    if (rest[1] === 'comments' && rest.length === 3) {
      if (method === 'GET') getComment(h, repo, rest[2] as string);
      else if (method === 'PATCH') await patchComment(h, repo, rest[2] as string);
      else if (method === 'DELETE') deleteComment(h, repo, rest[2] as string);
      else h.notFound();
      return;
    }
    const issue = issueByNumber(h, repo, rest[1] as string);
    if (issue === null) return;
    if (rest.length === 2) {
      if (method === 'GET') h.json(200, issueJson(h.store, repo, issue));
      else if (method === 'PATCH') await patchIssue(h, repo, issue);
      else h.notFound();
      return;
    }
    if (rest[2] === 'comments') {
      if (rest.length === 3) {
        if (method === 'GET') listComments(h, repo, issue);
        else if (method === 'POST') await createComment(h, repo, issue);
        else h.notFound();
      } else if (rest.length === 4) {
        if (method === 'PATCH') await patchComment(h, repo, rest[3] as string, issue);
        else if (method === 'DELETE') deleteComment(h, repo, rest[3] as string, issue);
        else h.notFound();
      } else h.notFound();
      return;
    }
    if (rest[2] === 'labels') {
      if (rest.length === 3) {
        if (method === 'GET') listIssueLabels(h, repo, issue);
        else if (method === 'POST') await addIssueLabels(h, repo, issue);
        else h.notFound();
      } else if (rest.length === 4) {
        if (method === 'DELETE') removeIssueLabel(h, repo, issue, rest[3] as string);
        else h.notFound();
      } else h.notFound();
      return;
    }
    h.notFound();
    return;
  }

  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') listPulls(h, repo);
      else if (method === 'POST') await createPull(h, repo);
      else h.notFound();
      return;
    }
    const pull = pullByNumber(h, repo, rest[1] as string);
    if (pull === null) return;
    if (rest.length === 2) {
      if (method === 'GET') getPull(h, repo, pull);
      else h.notFound();
      return;
    }
    if (rest[2] === 'files' && rest.length === 3) {
      if (method === 'GET') listPullFiles(h, repo, pull);
      else h.notFound();
      return;
    }
    if (rest[2] === 'reviews' && rest.length === 3) {
      if (method === 'GET') h.json(200, []);
      else h.notFound();
      return;
    }
    if (rest[2] === 'commits' && rest.length === 3) {
      if (method === 'GET') listPullCommits(h, repo, pull);
      else h.notFound();
      return;
    }
    if (rest[2] === 'merge' && rest.length === 3) {
      if (method === 'PUT') await mergePull(h, repo, pull);
      else h.notFound();
      return;
    }
    h.notFound();
    return;
  }

  h.notFound();
}

async function dispatch(h: H, segs: string[]): Promise<void> {
  const method = h.method;
  const head = segs[0];

  if (head === 'meta' && segs.length === 1) {
    if (method === 'GET') h.json(200, { installed_version: '1.0.0' });
    else h.notFound();
    return;
  }

  if (head === 'user') {
    if (segs.length === 1) {
      if (method === 'GET') h.json(200, userJson(h.store.viewer));
      else h.notFound();
      return;
    }
    if (segs[1] === 'repos' && segs.length === 2) {
      if (method === 'GET') listUserRepos(h);
      else if (method === 'POST') await createRepoFor(h, h.store.viewer.login);
      else h.notFound();
      return;
    }
    h.notFound();
    return;
  }

  if (head === 'users' && segs.length === 2) {
    if (method !== 'GET') {
      h.notFound();
      return;
    }
    const login = segs[1] as string;
    if (login === h.store.viewer.login) {
      h.json(200, userJson(h.store.viewer));
      return;
    }
    const known = h.store.users.get(login);
    if (known !== undefined) {
      h.json(200, userJson(known));
      return;
    }
    h.notFound();
    return;
  }

  if (head === 'orgs' && segs.length === 3 && segs[2] === 'repos') {
    if (method === 'POST') await createRepoFor(h, segs[1] as string);
    else h.notFound();
    return;
  }

  if (head === 'repos' && segs.length >= 3) {
    await dispatchRepos(h, segs[1] as string, segs[2] as string, segs.slice(3));
    return;
  }

  h.notFound();
}

/**
 * The REST v3 handler (INTEGRATION.md). app.ts calls it for paths under
 * /api/v3; it returns true when it answered (including the JSON 404 for
 * unknown routes under the prefix), false when the path is not this surface's.
 *
 * Auth is enforced by app.ts before dispatch; this handler re-checks it (via
 * ctx.authed) so a direct call is still safe. GET /api/v3/ (the root) needs
 * no auth, like the starter.
 */
export async function handleRest(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<boolean> {
  const path = ctx.path;
  if (path !== API_PREFIX && path !== `${API_PREFIX}/` && !path.startsWith(`${API_PREFIX}/`)) {
    return false;
  }
  if (path === API_PREFIX || path === `${API_PREFIX}/`) {
    if (ctx.method !== 'GET') {
      ctx.json(404, notFoundBody());
      return true;
    }
    ctx.json(
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { [OAUTH_SCOPES_HEADER]: OAUTH_SCOPES },
    );
    return true;
  }
  const authed = typeof ctx.authed === 'function' ? ctx.authed(req) : isAuthed(req, ctx.token);
  if (!authed) {
    ctx.json(401, unauthorizedBody());
    return true;
  }
  const store = ctx.store;
  if (store === null) {
    // store.ts has not landed yet (INTEGRATION.md fallback): never leak dev state.
    ctx.json(503, { message: 'Service Unavailable' });
    return true;
  }
  const h = new H(req, res, { ...ctx, store });
  await dispatch(h, splitPath(path).slice(2));
  return true;
}

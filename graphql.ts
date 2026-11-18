// graphql.ts — GraphQL v4: POST /api/graphql.
//
// A minimal GraphQL executor, sized to the documents the suite sends (kit
// program/env/src/checks-graphql.ts): operation query/mutation, field
// selection with aliases, arguments (literals, $variables, inline enum lists
// and input objects), inline + named fragments, __typename, and __type /
// __schema introspection. It is NOT a general GraphQL implementation.
//
// All data comes from the shared Store (store.ts); this module keeps no state
// of its own. No Date.now / Math.random / crypto randomness anywhere: global
// ids are base64 of a stable "<Kind>:<ids>" string, cursors are base64 of a
// stable "cursor:<Kind>:<number>" string, and timestamps come from the Store.
//
// Wiring (INTEGRATION.md): app.ts routes POST /api/graphql here and calls
// `handleGraphql(req, res, ctx)`; ctx carries the shared store, the token,
// requestId, path/query/method, `json(status, body)` and `readBody()`.
// Auth is enforced by app.ts before dispatch, so this handler assumes the
// caller is authed. It returns true when it answered, false when the request
// is not its surface (non-POST, or no store yet — app.ts then 404s).
// `executeGraphQL(store, body)` is the pure core (one operation object, or an
// array of them for GitHub's operation batching) and is what tests drive.
//
// Store operations this surface needs that store.ts does not provide
// (closeIssue, createPull, mergePull, pullFiles, pullMergeable) live in this
// file as `*InStore` helpers, mirroring rest.ts's semantics exactly (same
// squash-merge commit bytes, same merge-base diff, same one-tick-per-mutation
// rule) so the GraphQL, MCP and REST views of one pull request agree.
// mcp.ts imports the pull-request helpers from here.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildTree, parseCommit, parseTree, type TreeEntry } from './pack.ts';
import type { Issue, IssueComment, Pull, Repo, Store } from './store.ts';

// ---------------------------------------------------------------------------
// Handler context (structural copy of app.ts's Ctx; app.ts casts at the
// dynamic-import boundary, so this module never imports app.ts).
// ---------------------------------------------------------------------------

export interface HandlerCtx {
  store: Store | null;
  token: string;
  requestId: string;
  path: string;
  query: URLSearchParams;
  method: string;
  json(status: number, body: unknown, headers?: Record<string, string>): void;
  readBody(): Promise<Buffer>;
  authed(req: IncomingMessage): boolean;
}

// ---------------------------------------------------------------------------
// Global (Relay) ids and cursors — opaque, stable, deterministic.
// ---------------------------------------------------------------------------

function globalId(kind: string, ...parts: readonly (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

interface DecodedId {
  kind: string;
  parts: string[];
}

function decodeGlobalId(id: unknown): DecodedId | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  const kind = parts.shift();
  if (kind === undefined || kind === '' || parts.length === 0) return null;
  if (!/^[A-Za-z]+$/.test(kind)) return null;
  return { kind, parts };
}

function cursorFor(kind: string, number: number): string {
  return Buffer.from(`cursor:${kind}:${number}`, 'utf8').toString('base64');
}

// ---------------------------------------------------------------------------
// Schema table: the field set each type answers, and the enums.
// Used both for validation (unknown field -> errors) and for introspection.
// ---------------------------------------------------------------------------

/** Field name -> result type name (base name; `[X]` is a list of X). */
const FIELDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Query: {
    viewer: 'User',
    repository: 'Repository',
    node: 'Node',
    __type: '__Type',
    __schema: '__Schema',
  },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: {
    id: 'ID',
    databaseId: 'Int',
    name: 'String',
    nameWithOwner: 'String',
    owner: 'User',
    defaultBranchRef: 'Ref',
    viewerPermission: 'RepositoryPermission',
    hasIssuesEnabled: 'Boolean',
    description: 'String',
    private: 'Boolean',
    createdAt: 'String',
    updatedAt: 'String',
    pushedAt: 'String',
    url: 'String',
    htmlUrl: 'String',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  Issue: {
    id: 'ID',
    databaseId: 'Int',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'IssueState',
    author: 'User',
    createdAt: 'String',
    updatedAt: 'String',
    closedAt: 'String',
    comments: 'IssueCommentConnection',
    url: 'String',
  },
  PullRequest: {
    id: 'ID',
    databaseId: 'Int',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'PullRequestState',
    merged: 'Boolean',
    mergeable: 'MergeableState',
    headRefName: 'String',
    baseRefName: 'String',
    author: 'User',
    createdAt: 'String',
    updatedAt: 'String',
    mergedAt: 'String',
    files: 'PullRequestChangedFileConnection',
    url: 'String',
  },
  User: { id: 'ID', login: 'String', name: 'String', email: 'String', avatarUrl: 'String', url: 'String' },
  Node: { id: 'ID' },
  Ref: { id: 'ID', name: 'String', prefix: 'String' },
  IssueConnection: { nodes: '[Issue]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestConnection: { nodes: '[PullRequest]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestChangedFileConnection: { nodes: '[PullRequestChangedFile]', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueCommentConnection: { nodes: '[IssueComment]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestChangedFile: { path: 'String' },
  IssueComment: { id: 'ID', body: 'String', author: 'User', createdAt: 'String', updatedAt: 'String' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', clientMutationId: 'String' },
  __Type: {
    name: 'String',
    kind: '__TypeKind',
    description: 'String',
    fields: '[__Field]',
    enumValues: '[__EnumValue]',
    inputFields: '[__InputValue]',
    interfaces: '[__Type]',
    possibleTypes: '[__Type]',
    ofType: '__Type',
    specifiedByURL: 'String',
  },
  __Field: { name: 'String', description: 'String', args: '[__InputValue]', type: '__Type', isDeprecated: 'Boolean', deprecationReason: 'String' },
  __InputValue: { name: 'String', description: 'String', type: '__Type', defaultValue: 'String' },
  __EnumValue: { name: 'String', description: 'String', isDeprecated: 'Boolean', deprecationReason: 'String' },
  __Schema: { types: '[__Type]', queryType: '__Type', mutationType: '__Type', subscriptionType: '__Type', directives: '[__Directive]' },
  __Directive: { name: 'String', description: 'String', locations: '[String]', args: '[__InputValue]', isRepeatable: 'Boolean' },
};

const ENUMS: Readonly<Record<string, readonly string[]>> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'WIKI'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  __TypeKind: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'],
};

/** Input-object fields, for __type(...).inputFields and for documentation. */
const INPUT_FIELDS: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  CreateIssueInput: [
    ['repositoryId', 'ID'],
    ['title', 'String'],
    ['body', 'String'],
    ['clientMutationId', 'String'],
  ],
  CloseIssueInput: [
    ['issueId', 'ID'],
    ['clientMutationId', 'String'],
  ],
  CreatePullRequestInput: [
    ['repositoryId', 'ID'],
    ['baseRefName', 'String'],
    ['headRefName', 'String'],
    ['title', 'String'],
    ['body', 'String'],
    ['clientMutationId', 'String'],
  ],
  MergePullRequestInput: [
    ['pullRequestId', 'ID'],
    ['mergeMethod', 'PullRequestMergeMethod'],
    ['clientMutationId', 'String'],
  ],
  AddCommentInput: [
    ['subjectId', 'ID'],
    ['body', 'String'],
    ['clientMutationId', 'String'],
  ],
  IssueOrder: [
    ['field', 'IssueOrderField'],
    ['direction', 'OrderDirection'],
  ],
};

const SCALARS = new Set(['ID', 'Int', 'Float', 'String', 'Boolean']);

function typeKind(name: string): string {
  if (SCALARS.has(name)) return 'SCALAR';
  if (name in ENUMS) return 'ENUM';
  if (name in INPUT_FIELDS) return 'INPUT_OBJECT';
  if (name === 'Node') return 'INTERFACE';
  return 'OBJECT';
}

/** The base type name of a (possibly list / non-null) type spelling. */
function baseTypeName(type: string): string {
  return type.replace(/[\[\]!]/g, '');
}

// ---------------------------------------------------------------------------
// Store operations (issue / pull-request mutations + git reads).
//
// store.ts provides createIssue / addIssueComment / createRepo / putObject /
// getObject; the close / pull-request-create / merge / files / mergeable
// operations below are local helpers that mirror rest.ts exactly, so the
// GraphQL, MCP and REST views of one pull request agree. Each mutating
// helper ticks the logical clock exactly once, like rest.ts does.
// ---------------------------------------------------------------------------

/** A git object, from the repo's own map first, then the store-level map. */
function getObject(store: Store, repo: Repo, sha: string): { type: string; data: Buffer } | undefined {
  return repo.objects.get(sha) ?? store.getObject(sha);
}

/** Store a git object the way rest.ts does (store-level map). */
function putGitObject(store: Store, type: 'blob' | 'tree' | 'commit' | 'tag', data: Buffer): string {
  return store.putObject(type, data);
}

function parseCommitSafe(store: Store, repo: Repo, sha: string): { tree: string; parents: string[] } | null {
  const obj = getObject(store, repo, sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  try {
    const parsed = parseCommit(obj.data);
    return { tree: parsed.tree, parents: [...parsed.parents] };
  } catch {
    return null;
  }
}

function treeShaOfCommit(store: Store, repo: Repo, sha: string): string | null {
  return parseCommitSafe(store, repo, sha)?.tree ?? null;
}

interface FileEntry {
  sha: string;
  mode: string;
}

/** All files under a tree, as path -> blob. Empty map for a null/missing tree. */
function fileMapOf(store: Store, repo: Repo, treeSha: string | null, prefix: string, out: Map<string, FileEntry>): Map<string, FileEntry> {
  if (treeSha === null) return out;
  const obj = getObject(store, repo, treeSha);
  if (obj === undefined || obj.type !== 'tree') return out;
  let entries: TreeEntry[];
  try {
    entries = parseTree(obj.data);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      fileMapOf(store, repo, entry.oid, path, out);
    } else {
      out.set(path, { sha: entry.oid, mode: entry.mode });
    }
  }
  return out;
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
    const info = parseCommitSafe(store, repo, sha);
    if (info === null) continue;
    out.push(sha);
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

interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  newSha: string | null;
}

/** Diff two trees (base -> head) as file changes, paths sorted. */
function diffTrees(store: Store, repo: Repo, baseTree: string | null, headTree: string | null): FileChange[] {
  const base = fileMapOf(store, repo, baseTree, '', new Map());
  const head = fileMapOf(store, repo, headTree, '', new Map());
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) out.push({ path, status: 'removed', newSha: null });
    else if (b === undefined && h !== undefined) out.push({ path, status: 'added', newSha: h.sha });
    else if (b !== undefined && h !== undefined && b.sha !== h.sha) out.push({ path, status: 'modified', newSha: h.sha });
  }
  return out;
}

/** Would merging `headTip` into `baseTip` (merge-base `base`) conflict? Three-way, per path. */
function mergeWouldConflict(store: Store, repo: Repo, mergeBaseSha: string | null, headTip: string, baseTip: string): boolean {
  const baseTree = mergeBaseSha === null ? null : treeShaOfCommit(store, repo, mergeBaseSha);
  const headTree = treeShaOfCommit(store, repo, headTip);
  const tipTree = treeShaOfCommit(store, repo, baseTip);
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

/** Build a whole tree from a file map (used for squash merges). */
function treeFromFileMap(store: Store, files: Map<string, FileEntry>): string {
  const build = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const subdirs = new Map<string, Map<string, FileEntry>>();
    for (const [path, entry] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.push({ mode: entry.mode, name: rest, oid: entry.sha });
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
    for (const dir of subdirs.keys()) {
      entries.push({ mode: '40000', name: dir, oid: build(`${prefix}${dir}/`) });
    }
    return putGitObject(store, 'tree', buildTree(entries));
  };
  return build('');
}

/** Epoch seconds for a Store.clock ISO string, computed without `new Date`. */
function epochOf(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(iso);
  if (m === null) return 0;
  return Math.floor(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) / 1000);
}

/** A commit object in exactly rest.ts's serializeCommit shape. */
function serializeMergeCommit(fields: {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorEpoch: number;
  committerName: string;
  committerEmail: string;
  committerEpoch: number;
  message: string;
}): Buffer {
  let out = `tree ${fields.tree}\n`;
  for (const parent of fields.parents) out += `parent ${parent}\n`;
  out += `author ${fields.authorName} <${fields.authorEmail}> ${fields.authorEpoch} +0000\n`;
  out += `committer ${fields.committerName} <${fields.committerEmail}> ${fields.committerEpoch} +0000\n`;
  out += `\n${fields.message}\n`;
  return Buffer.from(out, 'utf8');
}

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}

/** Close an issue (mirrors rest.ts PATCH /issues/{n}): one clock tick. */
export function closeIssueInStore(store: Store, repo: Repo, number: number): Issue | undefined {
  const issue = repo.issues.get(number);
  if (issue === undefined) return undefined;
  const now = store.clock.nowIso();
  issue.state = 'closed';
  issue.closed_at = now;
  issue.updated_at = now;
  store.clock.tick();
  return issue;
}

/**
 * Create a pull request (mirrors rest.ts POST /pulls): head/base are branch
 * names (an `owner:` prefix is stripped); undefined when either ref is
 * missing. One clock tick. mergeable is computed at creation, like REST.
 */
export function createPullInStore(
  store: Store,
  repo: Repo,
  opts: { title: string; body?: string; head: string; base: string },
): Pull | undefined {
  const head = stripOwnerPrefix(opts.head);
  const base = stripOwnerPrefix(opts.base);
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (headTip === undefined || baseTip === undefined) return undefined;
  const now = store.clock.nowIso();
  const number = repo.nextPull;
  const pull: Pull = {
    id: number,
    number,
    title: opts.title,
    body: opts.body ?? '',
    state: 'open',
    merged: false,
    mergeable: true,
    head: { label: `${repo.owner}:${head}`, ref: head, sha: headTip },
    base: { label: `${repo.owner}:${base}`, ref: base, sha: baseTip },
    user: store.viewer.login,
    created_at: now,
    updated_at: now,
    merged_at: null,
    merge_commit_sha: null,
  };
  const mb = mergeBaseOf(store, repo, headTip, baseTip);
  pull.mergeable = mb !== null && !mergeWouldConflict(store, repo, mb, headTip, baseTip);
  repo.nextPull += 1;
  repo.pulls.set(number, pull);
  store.clock.tick();
  return pull;
}

/**
 * Squash-merge a pull request (mirrors rest.ts PUT /pulls/{n}/merge): the
 * head-vs-merge-base changes are applied onto the current base tip tree, one
 * merge commit is built with rest.ts's exact bytes, and the base ref advances
 * to it. Every mergeMethod (MERGE/SQUASH/REBASE) squashes, as REST does.
 * Returns undefined when the PR is missing, already merged/closed, has no
 * merge base, or would conflict. One clock tick.
 */
export function mergePullInStore(store: Store, repo: Repo, pull: Pull, _method: 'MERGE' | 'SQUASH' | 'REBASE'): Pull | undefined {
  if (pull.merged || pull.state !== 'open') return undefined;
  const baseRef = `refs/heads/${pull.base.ref}`;
  const baseTip = repo.refs.get(baseRef);
  if (baseTip === undefined) return undefined;
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  const mb = mergeBaseOf(store, repo, headTip, baseTip);
  if (mb === null) return undefined;
  if (mergeWouldConflict(store, repo, mb, headTip, baseTip)) return undefined;
  const mbTree = treeShaOfCommit(store, repo, mb);
  const headTree = treeShaOfCommit(store, repo, headTip);
  const baseTree = treeShaOfCommit(store, repo, baseTip);
  const changes = diffTrees(store, repo, mbTree, headTree);
  const merged = fileMapOf(store, repo, baseTree, '', new Map());
  for (const change of changes) {
    if (change.status === 'removed') merged.delete(change.path);
    else if (change.newSha !== null) merged.set(change.path, { sha: change.newSha, mode: '100644' });
  }
  const mergedTree = treeFromFileMap(store, merged);
  const now = store.clock.nowIso();
  const epoch = epochOf(now);
  const viewer = store.viewer;
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head.ref}`;
  const mergeSha = putGitObject(
    store,
    'commit',
    serializeMergeCommit({
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
  repo.refs.set(baseRef, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = now;
  pull.merge_commit_sha = mergeSha;
  pull.updated_at = now;
  repo.updated_at = now;
  repo.pushed_at = now;
  store.clock.tick();
  return pull;
}

/** The changed paths of a pull request (merge-base tree -> head tree), sorted. */
export function pullFilesInStore(store: Store, repo: Repo, pull: Pull): string[] {
  const headTree = treeShaOfCommit(store, repo, pull.head.sha);
  const mb = mergeBaseOf(store, repo, pull.head.sha, pull.base.sha);
  const baseTree = mb === null ? treeShaOfCommit(store, repo, pull.base.sha) : treeShaOfCommit(store, repo, mb);
  return diffTrees(store, repo, baseTree, headTree).map((change) => change.path);
}

/** A pull request's mergeability, computed live like rest.ts does on read. */
export function pullMergeableInStore(store: Store, repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
  if (baseTip === undefined) return 'UNKNOWN';
  const mb = mergeBaseOf(store, repo, pull.head.sha, baseTip);
  if (mb === null) return 'UNKNOWN';
  return mergeWouldConflict(store, repo, mb, pull.head.sha, baseTip) ? 'CONFLICTING' : 'MERGEABLE';
}

// ---------------------------------------------------------------------------
// Lexer + parser (documents only; no schema language).
// ---------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
  value: string;
  line: number;
  column: number;
}

class LexError extends Error {
  line: number;
  column: number;
  constructor(message: string, line: number, column: number) {
    super(message);
    this.name = 'LexError';
    this.line = line;
    this.column = column;
  }
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;
  const push = (kind: Token['kind'], value: string, startLine: number, startColumn: number): void => {
    tokens.push({ kind, value, line: startLine, column: startColumn });
  };
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === ',' || ch === '\r') {
      i += 1;
      column += 1;
      continue;
    }
    if (ch === '\n') {
      i += 1;
      line += 1;
      column = 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') {
        i += 1;
        column += 1;
      }
      continue;
    }
    const startLine = line;
    const startColumn = column;
    if (ch === '"') {
      // Block string """...""" or a normal "..." string.
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new LexError('Unterminated block string', startLine, startColumn);
        const raw = source.slice(i + 3, end);
        for (const c of raw) {
          if (c === '\n') {
            line += 1;
            column = 1;
          } else {
            column += 1;
          }
        }
        i = end + 3;
        column += 3;
        push('string', raw.replace(/^\n/, '').replace(/\n$/, ''), startLine, startColumn);
        continue;
      }
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < source.length) {
        const c = source[j]!;
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === '\n') throw new LexError('Unterminated string', startLine, startColumn);
        if (c === '\\') {
          const esc = source[j + 1];
          if (esc === undefined) break;
          const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            const hex = source.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new LexError('Bad unicode escape', startLine, startColumn);
            value += String.fromCharCode(Number.parseInt(hex, 16));
            j += 6;
          } else if (esc in simple) {
            value += simple[esc];
            j += 2;
          } else {
            throw new LexError(`Bad escape \\${esc}`, startLine, startColumn);
          }
          continue;
        }
        value += c;
        j += 1;
      }
      if (!closed) throw new LexError('Unterminated string', startLine, startColumn);
      column += j + 1 - i;
      i = j + 1;
      push('string', value, startLine, startColumn);
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      const text = source.slice(i, j);
      column += j - i;
      i = j;
      push(isFloat ? 'float' : 'int', text, startLine, startColumn);
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j]!)) j += 1;
      const text = source.slice(i, j);
      column += j - i;
      i = j;
      push('name', text, startLine, startColumn);
      continue;
    }
    if (source.startsWith('...', i)) {
      i += 3;
      column += 3;
      push('punct', '...', startLine, startColumn);
      continue;
    }
    if ('!$&():=@[]{}|'.includes(ch)) {
      i += 1;
      column += 1;
      push('punct', ch, startLine, startColumn);
      continue;
    }
    throw new LexError(`Unexpected character ${JSON.stringify(ch)}`, startLine, startColumn);
  }
  tokens.push({ kind: 'eof', value: '', line, column });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface SelectionNode {
  kind: 'field' | 'inlineFragment' | 'spread';
  /** Field name, or fragment name for a spread. */
  name?: string;
  alias?: string;
  typeCondition?: string;
  args?: { name: string; value: ValueNode }[];
  selections?: SelectionNode[];
}

interface OperationNode {
  type: 'query' | 'mutation' | 'subscription';
  name?: string;
  varDefs: { name: string; type: string; defaultValue?: ValueNode }[];
  selections: SelectionNode[];
}

interface FragmentDef {
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentDef>;
}

class ParseError extends Error {
  line: number;
  column: number;
  constructor(message: string, line: number, column: number) {
    super(message);
    this.name = 'ParseError';
    this.line = line;
    this.column = column;
  }
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expectPunct(value: string): Token {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new ParseError(`Expected "${value}", found ${JSON.stringify(token.value)}`, token.line, token.column);
    }
    return token;
  }

  private expectName(value?: string): Token {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new ParseError(`Expected name${value === undefined ? '' : ` "${value}"`}, found ${JSON.stringify(token.value)}`, token.line, token.column);
    }
    return token;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', varDefs: [], selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const type = this.next().value as 'query' | 'mutation' | 'subscription';
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        const varDefs = this.parseVariableDefinitions();
        operations.push({ type, name, varDefs, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName().value;
        this.expectName('on');
        const typeCondition = this.expectName().value;
        fragments.set(name, { typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      throw new ParseError(`Unexpected ${JSON.stringify(token.value)}`, token.line, token.column);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): { name: string; type: string; defaultValue?: ValueNode }[] {
    const defs: { name: string; type: string; defaultValue?: ValueNode }[] = [];
    if (this.peek().kind !== 'punct' || this.peek().value !== '(') return defs;
    this.next();
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName().value;
      this.expectPunct(':');
      const type = this.parseTypeName();
      let defaultValue: ValueNode | undefined;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push(defaultValue === undefined ? { name, type } : { name, type, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseTypeName(): string {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      const inner = this.parseTypeName();
      this.expectPunct(']');
      let out = `[${inner}]`;
      if (this.peek().kind === 'punct' && this.peek().value === '!') {
        this.next();
        out += '!';
      }
      return out;
    }
    const name = this.expectName().value;
    let out = name;
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      out += '!';
    }
    return out;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') {
        const token = this.peek();
        throw new ParseError('Unterminated selection set', token.line, token.column);
      }
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName().value;
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        const name = this.next().value;
        return { kind: 'spread', name };
      }
      throw new ParseError('Expected a fragment name or "on"', next.line, next.column);
    }
    const first = this.expectName().value;
    let alias: string | undefined;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName().value;
    }
    let args: { name: string; value: ValueNode }[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      args = this.parseArguments();
    }
    let selections: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName().value;
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'string':
        return { kind: 'string', value: token.value };
      case 'int':
        return { kind: 'int', value: Number.parseInt(token.value, 10) };
      case 'float':
        return { kind: 'float', value: Number.parseFloat(token.value) };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      case 'punct':
        if (token.value === '$') return { kind: 'variable', name: this.expectName().value };
        if (token.value === '[') {
          const items: ValueNode[] = [];
          while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
            items.push(this.parseValue());
          }
          this.expectPunct(']');
          return { kind: 'list', items };
        }
        if (token.value === '{') {
          const fields: { name: string; value: ValueNode }[] = [];
          while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
            const name = this.expectName().value;
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue() });
          }
          this.expectPunct('}');
          return { kind: 'object', fields };
        }
        break;
    }
    throw new ParseError(`Unexpected value ${JSON.stringify(token.value)}`, token.line, token.column);
  }
}

// ---------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------

interface GqlError {
  message: string;
  path?: (string | number)[];
  locations?: { line: number; column: number }[];
}

/** One resolved object: its __typename plus the store rows it reads from. */
interface NodeObj {
  __typename: string;
  [key: string]: unknown;
}

interface ExecContext {
  store: Store;
  doc: DocumentNode;
  variables: Record<string, unknown>;
  errors: GqlError[];
}

class ResolverError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(args: { name: string; value: ValueNode }[] | undefined, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args ?? []) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// --- node factories ---------------------------------------------------------

function userNode(store: Store, login: string): NodeObj {
  const viewer = store.viewer;
  if (login === viewer.login) {
    return {
      __typename: 'User',
      id: globalId('User', login),
      login,
      name: viewer.name,
      email: viewer.email,
      avatarUrl: viewer.avatar_url,
      url: viewer.url,
    };
  }
  return { __typename: 'User', id: globalId('User', login), login, name: null, email: null, avatarUrl: null, url: null };
}

function repoNode(repo: Repo): NodeObj {
  return { __typename: 'Repository', repo };
}

function issueNode(repo: Repo, issue: Issue): NodeObj {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: Pull): NodeObj {
  return { __typename: 'PullRequest', repo, pull };
}

function commentNode(repo: Repo, issue: Issue, comment: IssueComment): NodeObj {
  return { __typename: 'IssueComment', repo, issue, comment };
}

function pageInfoNode(pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }): NodeObj {
  return { __typename: 'PageInfo', ...pageInfo };
}

// --- lookups by global id ---------------------------------------------------

function findRepoById(store: Store, databaseId: number): Repo | undefined {
  for (const repo of store.repos.values()) {
    if (repo.id === databaseId) return repo;
  }
  return undefined;
}

function findRepoByGlobalId(store: Store, id: unknown): Repo | undefined {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository' || decoded.parts.length !== 1) return undefined;
  const databaseId = Number(decoded.parts[0]);
  if (!Number.isInteger(databaseId)) return undefined;
  return findRepoById(store, databaseId);
}

function findIssueByGlobalId(store: Store, id: unknown): { repo: Repo; issue: Issue } | undefined {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue' || decoded.parts.length !== 2) return undefined;
  const repo = findRepoById(store, Number(decoded.parts[0]));
  if (repo === undefined) return undefined;
  const issue = repo.issues.get(Number(decoded.parts[1]));
  if (issue === undefined) return undefined;
  return { repo, issue };
}

function findPullByGlobalId(store: Store, id: unknown): { repo: Repo; pull: Pull } | undefined {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest' || decoded.parts.length !== 2) return undefined;
  const repo = findRepoById(store, Number(decoded.parts[0]));
  if (repo === undefined) return undefined;
  const pull = repo.pulls.get(Number(decoded.parts[1]));
  if (pull === undefined) return undefined;
  return { repo, pull };
}

// --- connections ------------------------------------------------------------

function paginate<T>(items: readonly T[], args: Record<string, unknown>, cursorOf: (item: T) => string, toNode: (item: T) => NodeObj, typename: string): NodeObj {
  const first = typeof args.first === 'number' && Number.isInteger(args.first) ? args.first : 30;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const index = items.findIndex((item) => cursorOf(item) === args.after);
    if (index >= 0) start = index + 1;
  }
  const pageItems = items.slice(start, start + Math.max(0, first));
  const nodes = pageItems.map(toNode);
  return {
    __typename: typename,
    nodes,
    pageInfo: pageInfoNode({
      hasNextPage: start + pageItems.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: pageItems.length > 0 ? cursorOf(pageItems[0]!) : null,
      endCursor: pageItems.length > 0 ? cursorOf(pageItems[pageItems.length - 1]!) : null,
    }),
    totalCount: items.length,
  };
}

function issueConnection(repo: Repo, args: Record<string, unknown>): NodeObj {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : String(state).toLowerCase())));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : undefined;
  if (orderBy !== undefined) {
    const direction = orderBy.direction === 'DESC' ? -1 : 1;
    const keyOf = (issue: Issue): string | number => {
      if (orderBy.field === 'UPDATED_AT') return issue.updated_at;
      if (orderBy.field === 'COMMENTS') return issue.comments.length;
      return issue.created_at;
    };
    list.sort((a, b) => {
      const ka = keyOf(a);
      const kb = keyOf(b);
      if (ka < kb) return -direction;
      if (ka > kb) return direction;
      return a.number - b.number;
    });
  } else {
    list.sort((a, b) => a.number - b.number);
  }
  return paginate(list, args, (issue) => cursorFor('Issue', issue.number), (issue) => issueNode(repo, issue), 'IssueConnection');
}

function pullConnection(repo: Repo, args: Record<string, unknown>): NodeObj {
  const list = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
  return paginate(list, args, (pull) => cursorFor('PullRequest', pull.number), (pull) => pullNode(repo, pull), 'PullRequestConnection');
}

function commentConnection(repo: Repo, issue: Issue, args: Record<string, unknown>): NodeObj {
  return paginate(
    issue.comments,
    args,
    (comment) => cursorFor('IssueComment', comment.id),
    (comment) => commentNode(repo, issue, comment),
    'IssueCommentConnection',
  );
}

function filesConnection(store: Store, repo: Repo, pull: Pull, args: Record<string, unknown>): NodeObj {
  const paths = pullFilesInStore(store, repo, pull);
  const entries = paths.map((path, index) => ({ path, index }));
  return paginate(
    entries,
    args,
    (entry) => cursorFor('PullRequestChangedFile', entry.index),
    (entry) => ({ __typename: 'PullRequestChangedFile', path: entry.path }),
    'PullRequestChangedFileConnection',
  );
}

// --- field resolution -------------------------------------------------------

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveField(ctx: ExecContext, node: NodeObj, field: string, args: Record<string, unknown>): unknown {
  const store = ctx.store;
  const typeName = node.__typename;
  switch (typeName) {
    case 'Query': {
      if (field === 'viewer') return userNode(store, store.viewer.login);
      if (field === 'repository') {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : repoNode(repo);
      }
      if (field === 'node') {
        const decoded = decodeGlobalId(args.id);
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const repo = findRepoById(store, Number(decoded.parts[0]));
          return repo === undefined ? null : repoNode(repo);
        }
        if (decoded.kind === 'Issue') {
          const found = findIssueByGlobalId(store, args.id);
          return found === undefined ? null : issueNode(found.repo, found.issue);
        }
        if (decoded.kind === 'PullRequest') {
          const found = findPullByGlobalId(store, args.id);
          return found === undefined ? null : pullNode(found.repo, found.pull);
        }
        return null;
      }
      if (field === '__type') {
        const name = args.name;
        if (typeof name !== 'string' || (!(name in FIELDS) && !(name in ENUMS) && !(name in INPUT_FIELDS) && !SCALARS.has(name))) return null;
        return { __typename: '__Type', typeName: name };
      }
      if (field === '__schema') return { __typename: '__Schema' };
      return null;
    }
    case 'Mutation': {
      if (field === 'createIssue') return mutateCreateIssue(ctx, args);
      if (field === 'closeIssue') return mutateCloseIssue(ctx, args);
      if (field === 'createPullRequest') return mutateCreatePullRequest(ctx, args);
      if (field === 'mergePullRequest') return mutateMergePullRequest(ctx, args);
      if (field === 'addComment') return mutateAddComment(ctx, args);
      return null;
    }
    case 'Repository': {
      const repo = node.repo as Repo;
      switch (field) {
        case 'id':
          return globalId('Repository', repo.id);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return repo.full_name;
        case 'owner':
          return userNode(store, repo.owner);
        case 'defaultBranchRef': {
          const sha = repo.refs.get(`refs/heads/${repo.default_branch}`);
          return sha === undefined ? null : { __typename: 'Ref', id: globalId('Ref', repo.id, repo.default_branch), name: repo.default_branch, prefix: 'refs/heads/' };
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'private':
          return repo.private;
        case 'createdAt':
          return repo.created_at;
        case 'updatedAt':
          return repo.updated_at;
        case 'pushedAt':
          return repo.pushed_at;
        case 'url':
          return `/api/v3/repos/${repo.owner}/${repo.name}`;
        case 'htmlUrl':
          return `/${repo.owner}/${repo.name}`;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : issueNode(repo, issue);
        }
        case 'issues':
          return issueConnection(repo, args);
        case 'pullRequests':
          return pullConnection(repo, args);
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : pullNode(repo, pull);
        }
        default:
          return null;
      }
    }
    case 'Issue': {
      const repo = node.repo as Repo;
      const issue = node.issue as Issue;
      switch (field) {
        case 'id':
          return globalId('Issue', repo.id, issue.number);
        case 'databaseId':
          return issue.id;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'author':
          return userNode(store, issue.user);
        case 'createdAt':
          return issue.created_at;
        case 'updatedAt':
          return issue.updated_at;
        case 'closedAt':
          return issue.closed_at;
        case 'comments':
          return commentConnection(repo, issue, args);
        case 'url':
          return `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`;
        default:
          return null;
      }
    }
    case 'PullRequest': {
      const repo = node.repo as Repo;
      const pull = node.pull as Pull;
      switch (field) {
        case 'id':
          return globalId('PullRequest', repo.id, pull.number);
        case 'databaseId':
          return pull.id;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullState(pull);
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return pullMergeableInStore(store, repo, pull);
        case 'headRefName':
          return pull.head.ref;
        case 'baseRefName':
          return pull.base.ref;
        case 'author':
          return userNode(store, pull.user);
        case 'createdAt':
          return pull.created_at;
        case 'updatedAt':
          return pull.updated_at;
        case 'mergedAt':
          return pull.merged_at;
        case 'files':
          return filesConnection(store, repo, pull, args);
        case 'url':
          return `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`;
        default:
          return null;
      }
    }
    case 'IssueComment': {
      const repo = node.repo as Repo;
      const issue = node.issue as Issue;
      const comment = node.comment as IssueComment;
      switch (field) {
        case 'id':
          return globalId('IssueComment', repo.id, issue.number, comment.id);
        case 'body':
          return comment.body;
        case 'author':
          return userNode(store, comment.user);
        case 'createdAt':
          return comment.created_at;
        case 'updatedAt':
          return comment.updated_at;
        default:
          return null;
      }
    }
    case '__Type': {
      const typeName = node.typeName as string;
      switch (field) {
        case 'name':
          return typeName;
        case 'kind':
          return typeKind(typeName);
        case 'description':
          return null;
        case 'fields': {
          if (typeKind(typeName) !== 'OBJECT' && typeKind(typeName) !== 'INTERFACE') return null;
          const fields = FIELDS[typeName] ?? {};
          return Object.keys(fields).map((name) => ({
            __typename: '__Field',
            name,
            description: null,
            args: [] as NodeObj[],
            type: { __typename: '__Type', typeName: baseTypeName(fields[name]!) },
            isDeprecated: false,
            deprecationReason: null,
          }));
        }
        case 'enumValues': {
          const values = ENUMS[typeName];
          if (values === undefined) return null;
          return values.map((name) => ({ __typename: '__EnumValue', name, description: null, isDeprecated: false, deprecationReason: null }));
        }
        case 'inputFields': {
          const inputs = INPUT_FIELDS[typeName];
          if (inputs === undefined) return null;
          return inputs.map(([name, type]) => ({
            __typename: '__InputValue',
            name,
            description: null,
            type: { __typename: '__Type', typeName: baseTypeName(type) },
            defaultValue: null,
          }));
        }
        case 'interfaces':
          return [];
        case 'possibleTypes': {
          if (typeName === 'Node') {
            return ['Repository', 'Issue', 'PullRequest'].map((name) => ({ __typename: '__Type', typeName: name }));
          }
          return [];
        }
        case 'ofType':
          return null;
        case 'specifiedByURL':
          return null;
        default:
          return null;
      }
    }
    case '__Schema': {
      switch (field) {
        case 'types': {
          const names = new Set<string>([...Object.keys(FIELDS), ...Object.keys(ENUMS), ...Object.keys(INPUT_FIELDS), ...SCALARS]);
          return [...names].sort().map((name) => ({ __typename: '__Type', typeName: name }));
        }
        case 'queryType':
          return { __typename: '__Type', typeName: 'Query' };
        case 'mutationType':
          return { __typename: '__Type', typeName: 'Mutation' };
        case 'subscriptionType':
          return null;
        case 'directives':
          return [];
        default:
          return null;
      }
    }
    default: {
      // Payloads, connections, edges, PageInfo, User, Ref, __Field, __InputValue,
      // __EnumValue, __Directive: plain property reads.
      const value = node[field];
      return value === undefined ? null : value;
    }
  }
}

// --- mutations --------------------------------------------------------------

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  return isRecord(args.input) ? args.input : {};
}

function mutateCreateIssue(ctx: ExecContext, args: Record<string, unknown>): NodeObj {
  const input = inputOf(args);
  const repo = findRepoByGlobalId(ctx.store, input.repositoryId);
  if (repo === undefined) throw new ResolverError();
  const title = input.title;
  if (typeof title !== 'string' || title === '') throw new ResolverError();
  const body = typeof input.body === 'string' ? input.body : '';
  const issue = ctx.store.createIssue(repo, { title, body });
  return {
    __typename: 'CreateIssuePayload',
    issue: issueNode(repo, issue),
    clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
  };
}

function mutateCloseIssue(ctx: ExecContext, args: Record<string, unknown>): NodeObj {
  const input = inputOf(args);
  const found = findIssueByGlobalId(ctx.store, input.issueId);
  if (found === undefined) throw new ResolverError();
  const closed = closeIssueInStore(ctx.store, found.repo, found.issue.number);
  if (closed === undefined) throw new ResolverError();
  return {
    __typename: 'CloseIssuePayload',
    issue: issueNode(found.repo, closed),
    clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
  };
}

function mutateCreatePullRequest(ctx: ExecContext, args: Record<string, unknown>): NodeObj {
  const input = inputOf(args);
  const repo = findRepoByGlobalId(ctx.store, input.repositoryId);
  if (repo === undefined) throw new ResolverError();
  const base = input.baseRefName;
  const head = input.headRefName;
  const title = input.title;
  if (typeof base !== 'string' || typeof head !== 'string' || typeof title !== 'string' || title === '') throw new ResolverError();
  const pull = createPullInStore(ctx.store, repo, { title, body: typeof input.body === 'string' ? input.body : '', head, base });
  if (pull === undefined) throw new ResolverError();
  return {
    __typename: 'CreatePullRequestPayload',
    pullRequest: pullNode(repo, pull),
    clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
  };
}

function mutateMergePullRequest(ctx: ExecContext, args: Record<string, unknown>): NodeObj {
  const input = inputOf(args);
  const found = findPullByGlobalId(ctx.store, input.pullRequestId);
  if (found === undefined) throw new ResolverError();
  const method = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'MERGE';
  if (method !== 'MERGE' && method !== 'SQUASH' && method !== 'REBASE') throw new ResolverError();
  const merged = mergePullInStore(ctx.store, found.repo, found.pull, method);
  if (merged === undefined) throw new ResolverError();
  return {
    __typename: 'MergePullRequestPayload',
    pullRequest: pullNode(found.repo, merged),
    clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
  };
}

function mutateAddComment(ctx: ExecContext, args: Record<string, unknown>): NodeObj {
  const input = inputOf(args);
  const found = findIssueByGlobalId(ctx.store, input.subjectId);
  if (found === undefined) throw new ResolverError();
  const body = input.body;
  if (typeof body !== 'string') throw new ResolverError();
  const comment = ctx.store.addIssueComment(found.repo, found.issue.number, body);
  if (comment === undefined) throw new ResolverError();
  return {
    __typename: 'AddCommentPayload',
    commentEdge: {
      __typename: 'IssueCommentEdge',
      node: commentNode(found.repo, found.issue, comment),
      cursor: cursorFor('IssueComment', comment.id),
    },
    clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
  };
}

// --- selection execution ----------------------------------------------------

function materialize(ctx: ExecContext, value: unknown, selections: SelectionNode[] | undefined, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry, index) => materialize(ctx, entry, selections, [...path, index]));
  if (isRecord(value) && typeof value.__typename === 'string') {
    if (selections === undefined || selections.length === 0) return {};
    return executeSelections(ctx, value as NodeObj, selections, path);
  }
  return value;
}

function executeSelections(ctx: ExecContext, node: NodeObj, selections: readonly SelectionNode[], path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeName = node.__typename;
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const name = selection.name!;
      const key = selection.alias ?? name;
      if (name === '__typename') {
        out[key] = typeName;
        continue;
      }
      const args = resolveArgs(selection.args, ctx.variables);
      let value: unknown;
      try {
        value = resolveField(ctx, node, name, args);
      } catch (err) {
        if (err instanceof ResolverError) {
          ctx.errors.push({ message: `Could not resolve field "${name}" on type "${typeName}".`, path: [...path, key] });
          out[key] = null;
          continue;
        }
        throw err;
      }
      out[key] = materialize(ctx, value, selection.selections, [...path, key]);
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === undefined || selection.typeCondition === typeName) {
        Object.assign(out, executeSelections(ctx, node, selection.selections ?? [], path));
      }
      continue;
    }
    // Named fragment spread.
    const fragment = ctx.doc.fragments.get(selection.name!);
    if (fragment !== undefined && (fragment.typeCondition === typeName || fragment.typeCondition === undefined)) {
      Object.assign(out, executeSelections(ctx, node, fragment.selections, path));
    }
  }
  return out;
}

// --- validation -------------------------------------------------------------

function validateSelections(doc: DocumentNode, typeName: string, selections: readonly SelectionNode[], errors: GqlError[]): void {
  const fields = FIELDS[typeName];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const name = selection.name!;
      if (name === '__typename') continue;
      if (fields === undefined || !(name in fields)) {
        errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
        continue;
      }
      if (selection.selections !== undefined && selection.selections.length > 0) {
        const childType = baseTypeName(fields[name]!);
        if (childType in FIELDS || childType in ENUMS || SCALARS.has(childType)) {
          validateSelections(doc, childType, selection.selections, errors);
        }
      }
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      const condition = selection.typeCondition ?? typeName;
      if (condition in FIELDS) validateSelections(doc, condition, selection.selections ?? [], errors);
      continue;
    }
    const fragment = doc.fragments.get(selection.name!);
    if (fragment === undefined) {
      errors.push({ message: `Unknown fragment "${selection.name}".` });
      continue;
    }
    if (fragment.typeCondition in FIELDS) validateSelections(doc, fragment.typeCondition, fragment.selections, errors);
  }
}

function validateOperation(doc: DocumentNode, operation: OperationNode): GqlError[] {
  const errors: GqlError[] = [];
  if (operation.type === 'subscription') {
    errors.push({ message: 'Subscriptions are not supported.' });
    return errors;
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  validateSelections(doc, rootType, operation.selections, errors);
  return errors;
}

// --- operation + batch execution --------------------------------------------

function executeOperation(store: Store, doc: DocumentNode, operation: OperationNode, variables: Record<string, unknown>): Record<string, unknown> {
  const mergedVariables: Record<string, unknown> = { ...variables };
  for (const def of operation.varDefs) {
    if (!(def.name in mergedVariables) || mergedVariables[def.name] === undefined) {
      if (def.defaultValue !== undefined) mergedVariables[def.name] = resolveValue(def.defaultValue, variables);
    }
  }
  const validationErrors = validateOperation(doc, operation);
  if (validationErrors.length > 0) return { data: null, errors: validationErrors };
  const ctx: ExecContext = { store, doc, variables: mergedVariables, errors: [] };
  const root: NodeObj = { __typename: operation.type === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelections(ctx, root, operation.selections, []);
  const body: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) body.errors = ctx.errors;
  return body;
}

function isOperationBody(value: unknown): value is { query?: unknown; variables?: unknown; operationName?: unknown } {
  return isRecord(value);
}

/**
 * Execute one operation body, or an array of them (GitHub's operation
 * batching: the answers come back in request order). The return value is the
 * JSON body to send (an object, or an array of objects for a batch).
 */
export function executeGraphQL(store: Store, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((entry) => executeOne(store, entry));
  }
  return executeOne(store, body);
}

function executeOne(store: Store, body: unknown): Record<string, unknown> {
  if (!isOperationBody(body) || typeof body.query !== 'string' || body.query.trim() === '') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  const variables = isRecord(body.variables) ? (body.variables as Record<string, unknown>) : {};
  let doc: DocumentNode;
  try {
    doc = new Parser(body.query).parseDocument();
  } catch (err) {
    if (err instanceof LexError || err instanceof ParseError) {
      return { data: null, errors: [{ message: `Syntax Error: ${err.message}`, locations: [{ line: err.line, column: err.column }] }] };
    }
    throw err;
  }
  if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'Must provide an operation.' }] };
  }
  let operation: OperationNode | undefined;
  if (typeof body.operationName === 'string' && body.operationName !== '') {
    operation = doc.operations.find((entry) => entry.name === body.operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${body.operationName}".` }] };
    }
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }
  return executeOperation(store, doc, operation, variables);
}

// ---------------------------------------------------------------------------
// HTTP handler (INTEGRATION.md contract).
// ---------------------------------------------------------------------------

/**
 * POST /api/graphql. Returns true when answered, false when the request is
 * not this surface (non-POST, or the store has not landed yet — app.ts then
 * answers its 404 JSON). Auth and the X-GitHub-Request-Id header are app.ts's
 * job; this handler only uses ctx.json / ctx.readBody. A body that is not
 * JSON is 400 {"message": ...} per INTEGRATION.md.
 */
export async function handleGraphql(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx): Promise<boolean> {
  void req;
  void res;
  const store = ctx.store;
  if (store === null) return false;
  if (ctx.method !== 'POST') return false;
  const raw = await ctx.readBody();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    ctx.json(400, { message: 'Problems parsing JSON' });
    return true;
  }
  ctx.json(200, executeGraphQL(store, parsed));
  return true;
}

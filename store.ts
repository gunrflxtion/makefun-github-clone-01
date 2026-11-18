// store.ts — the ONE in-memory Store every surface reads and writes.
//
// Determinism: no Date.now(), no Math.random(), no crypto.randomBytes() here.
// All timestamps come from the logical clock (base 2026-11-14T06:30:00.000Z,
// +1 second per mutating operation). Git objects pushed by clients are stored
// verbatim. Iteration order is Map insertion order (or an explicit sort).
//
// Viewer: the bearer token's user. checks-graphql.ts (query ViewerLogin) and
// checks-git.ts / checks-rest.ts (repositories are created under
// scenario.viewer.login) prove the viewer is the scenario's first user:
// login "adaiversen", id 1000, name "ada iversen", email
// "adaiversen@example.invalid" — derived from wire.ts SCENARIO_SEED
// 0x6a09e667f3bcc909, users[0]. STORE_API.md's "forge" default was wrong;
// this file and STORE_API.md now agree on the scenario viewer.

import { collectReachable, hashObject, isObjectId, parseCommit, parseTag, ZERO_OID } from './pack.ts';
import type { GitObject } from './pack.ts';

export type Sha1 = string;

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
  type: 'User' | 'Organization';
  avatar_url: string;
  html_url: string;
  url: string;
}

export function makeUser(id: number, login: string, name: string, email: string): User {
  return {
    id,
    login,
    name,
    email,
    type: 'User',
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    html_url: `https://github.com/${login}`,
    url: `https://api.github.com/users/${login}`,
  };
}

/** The scenario viewer (wire.ts buildScenario(): users[0]). */
export const VIEWER: User = makeUser(1000, 'adaiversen', 'ada iversen', 'adaiversen@example.invalid');

export interface GitObjectRecord {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  locked: boolean;
  labels: string[];
  assignees: string[];
  user: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean;
  head: { label: string; ref: string; sha: string };
  base: { label: string; ref: string; sha: string };
  user: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  objects: Map<Sha1, GitObject>;
  refs: Map<string, Sha1>;
  issues: Map<number, Issue>;
  nextIssue: number;
  pulls: Map<number, Pull>;
  nextPull: number;
  labels: Map<string, Label>;
  nextCommentId: number;
  /** Bumped on every successful ref change (and on creation); git.ts caches advertisements/packs per version. */
  version: number;
}

/** Logical clock: fixed base, +1 second per tick. Never reads the wall clock. */
export class LogicalClock {
  readonly #baseMs: number;
  #seconds = 0;

  constructor(baseIso = '2026-11-14T06:30:00.000Z') {
    this.#baseMs = Date.parse(baseIso);
  }

  nowIso(): string {
    return new Date(this.#baseMs + this.#seconds * 1000).toISOString();
  }

  tick(): void {
    this.#seconds += 1;
  }
}

export interface CreateRepoOpts {
  description?: string;
  private?: boolean;
  defaultBranch?: string;
}

export class Store {
  viewer: User;
  users: Map<string, User>;
  repos: Map<string, Repo>;
  clock: LogicalClock;
  nextRepoId: number;
  nextLabelId: number;

  constructor() {
    this.viewer = VIEWER;
    this.users = new Map([[VIEWER.login, VIEWER]]);
    this.repos = new Map();
    this.clock = new LogicalClock();
    this.nextRepoId = 1;
    this.nextLabelId = 1;
  }

  // -- repositories ----------------------------------------------------------

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  createRepo(owner: string, name: string, opts: CreateRepoOpts = {}): Repo {
    const now = this.clock.nowIso();
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      full_name: `${owner}/${name}`,
      description: opts.description ?? '',
      private: opts.private ?? false,
      default_branch: opts.defaultBranch ?? 'main',
      created_at: now,
      updated_at: now,
      pushed_at: now,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      nextIssue: 1,
      pulls: new Map(),
      nextPull: 1,
      labels: new Map(),
      nextCommentId: 1,
      version: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(repo.full_name, repo);
    this.clock.tick();
    return repo;
  }

  /** Remove a repo (REST DELETE). Returns false when it did not exist. */
  deleteRepo(owner: string, name: string): boolean {
    const deleted = this.repos.delete(`${owner}/${name}`);
    if (deleted) this.clock.tick();
    return deleted;
  }

  // -- git objects -----------------------------------------------------------
  //
  // Objects live per-repo (repo.objects). The optional `repo` argument scopes
  // the lookup; without it the helpers fall back to a store-wide search, which
  // is what REST contents / GraphQL helpers use when they already resolved the
  // repo. git.ts always passes the repo.

  putObject(type: GitObject['type'], data: Buffer, repo?: Repo): Sha1 {
    const oid = hashObject(type, data);
    const target = repo ?? null;
    if (target) {
      if (!target.objects.has(oid)) target.objects.set(oid, { type, data });
    } else {
      // Store-wide fallback: put into every repo is wrong; keep a single
      // store-level map instead (see `objects` below).
      if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    }
    return oid;
  }

  /** Store-level object map, used only by the no-repo putObject/getObject path. */
  readonly objects = new Map<Sha1, GitObject>();

  getObject(sha: Sha1, repo?: Repo): GitObject | undefined {
    if (repo) return repo.objects.get(sha);
    return this.objects.get(sha);
  }

  hasObject(sha: Sha1, repo?: Repo): boolean {
    if (repo) return repo.objects.has(sha);
    return this.objects.has(sha);
  }

  /** Every object reachable from `roots` inside this repo (throws on a missing object). */
  reachable(repo: Repo, roots: Iterable<string>): Set<string> {
    return collectReachable(roots, (oid) => repo.objects.get(oid));
  }

  /** Follow annotated tags until a commit (or the original oid); undefined when missing / not a commit. */
  peelToCommit(repo: Repo, oid: string): string | undefined {
    let current = oid;
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(current)) return undefined;
      seen.add(current);
      const object = repo.objects.get(current);
      if (!object) return undefined;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return undefined;
    }
  }

  /** True when `ancestor` (peeled to a commit) is reachable from `tip` (peeled to a commit). */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    const ancestorCommit = this.peelToCommit(repo, ancestor);
    const tipCommit = this.peelToCommit(repo, tip);
    if (ancestorCommit === undefined || tipCommit === undefined) return false;
    if (ancestorCommit === tipCommit) return true;
    const seen = new Set<string>();
    const queue: string[] = [tipCommit];
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestorCommit) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  // -- refs ------------------------------------------------------------------
  //
  // Every successful ref change stamps pushed_at and ticks the clock exactly
  // once, and bumps repo.version (git.ts cache invalidation).

  /**
   * Create or fast-forward-update `ref` to `newOid`.
   * `oldOid` must be the ref's current value (ZERO_OID when creating).
   * Returns { ok, reason }; reason is 'non-fast-forward' for a stale old
   * value, a non-descendant update, or creating an existing ref, and
   * 'object not found' / 'object is not a commit' for a bad target.
   */
  updateRef(repo: Repo, ref: string, newOid: string, oldOid: string): { ok: boolean; reason: string } {
    const current = repo.refs.get(ref);
    if (current === undefined) {
      if (oldOid !== ZERO_OID) return { ok: false, reason: 'non-fast-forward' };
    } else if (oldOid !== current) {
      return { ok: false, reason: 'non-fast-forward' };
    }
    if (newOid === ZERO_OID) return { ok: false, reason: 'non-fast-forward' };
    const object = repo.objects.get(newOid);
    if (!object) return { ok: false, reason: 'object not found' };
    if (ref.startsWith('refs/heads/') && object.type !== 'commit') {
      return { ok: false, reason: 'object is not a commit' };
    }
    if (current !== undefined && newOid !== current && !this.isAncestor(repo, current, newOid)) {
      return { ok: false, reason: 'non-fast-forward' };
    }
    repo.refs.set(ref, newOid);
    repo.pushed_at = this.clock.nowIso();
    repo.updated_at = repo.pushed_at;
    repo.version += 1;
    this.clock.tick();
    return { ok: true, reason: '' };
  }

  /** Delete `ref` when `oldOid` matches its current value. */
  deleteRef(repo: Repo, ref: string, oldOid: string): { ok: boolean; reason: string } {
    const current = repo.refs.get(ref);
    if (current === undefined) return { ok: false, reason: 'ref does not exist' };
    if (oldOid !== ZERO_OID && oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(ref);
    repo.pushed_at = this.clock.nowIso();
    repo.updated_at = repo.pushed_at;
    repo.version += 1;
    this.clock.tick();
    return { ok: true, reason: '' };
  }

  // -- labels / issues / pulls (REST, GraphQL, MCP helpers) -------------------
  //
  // Each mutating helper stamps with clock.nowIso() and ticks exactly once.

  createLabel(repo: Repo, name: string, color = 'ededed', description = ''): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = { id: this.nextLabelId, name, color, description };
    this.nextLabelId += 1;
    repo.labels.set(name, label);
    this.clock.tick();
    return label;
  }

  createIssue(
    repo: Repo,
    fields: { title: string; body?: string; labels?: string[]; assignees?: string[]; user?: string },
  ): Issue {
    const now = this.clock.nowIso();
    const number = repo.nextIssue;
    const issue: Issue = {
      id: number,
      number,
      title: fields.title,
      body: fields.body ?? '',
      state: 'open',
      locked: false,
      labels: fields.labels ? [...fields.labels] : [],
      assignees: fields.assignees ? [...fields.assignees] : [],
      user: fields.user ?? this.viewer.login,
      created_at: now,
      updated_at: now,
      closed_at: null,
      comments: [],
    };
    repo.nextIssue += 1;
    repo.issues.set(number, issue);
    this.clock.tick();
    return issue;
  }

  addIssueComment(repo: Repo, issueNumber: number, body: string, user?: string): IssueComment | undefined {
    const issue = repo.issues.get(issueNumber);
    if (!issue) return undefined;
    const now = this.clock.nowIso();
    const comment: IssueComment = {
      id: repo.nextCommentId,
      body,
      user: user ?? this.viewer.login,
      created_at: now,
      updated_at: now,
    };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    issue.updated_at = now;
    this.clock.tick();
    return comment;
  }

  createPull(
    repo: Repo,
    fields: {
      title: string;
      body?: string;
      head: { label: string; ref: string; sha: string };
      base: { label: string; ref: string; sha: string };
      user?: string;
    },
  ): Pull {
    const now = this.clock.nowIso();
    const number = repo.nextPull;
    const pull: Pull = {
      id: number,
      number,
      title: fields.title,
      body: fields.body ?? '',
      state: 'open',
      merged: false,
      mergeable: true,
      head: { ...fields.head },
      base: { ...fields.base },
      user: fields.user ?? this.viewer.login,
      created_at: now,
      updated_at: now,
      merged_at: null,
      merge_commit_sha: null,
    };
    repo.nextPull += 1;
    repo.pulls.set(number, pull);
    this.clock.tick();
    return pull;
  }
}

/** A fresh, empty store (the suite creates everything through the surfaces). */
export function createStore(): Store {
  return new Store();
}

export { ZERO_OID, isObjectId };

# STORE_API.md — shared store contract for github-core-clone-01

All four surfaces (git smart HTTP, REST v3, GraphQL v4, MCP) read and write ONE
in-memory `Store` (file `store.ts`, owned by the store+git worker). No other
module keeps its own copy of repo/issue/PR state. No disk writes at runtime
(the trial mounts /bot read-only; write only under /tmp, and this store never
writes at all). No `git` binary, no network, stdlib only (`node:http`,
`node:zlib`, `node:crypto`, `node:buffer`).

## Determinism (replay must be byte-identical)

- NEVER use `Date.now()`, `new Date()`, `Math.random()`, or `crypto.randomBytes()`
  in any response, stored field, or exported state. The suite replays the same
  request sequence and compares bytes.
- All timestamps come from `Store.clock`: a logical clock starting at the fixed
  base `2026-11-14T06:30:00.000Z` (competition open) that advances **1 second
  per mutation**. `clock.nowIso()` returns the current ISO string; `clock.tick()`
  advances it (called once per mutating operation). Two runs with the same
  request sequence produce identical timestamps.
- Git commit objects pushed by clients are stored VERBATIM (bytes as received,
  including their author/committer dates) — never re-stamp them.
- Iteration order everywhere is insertion order (Maps) or explicit sort by a
  stable key (e.g. issue number). Never iterate a `Set` whose order depends on
  hash/random. JSON bodies are built with fixed key order (construct objects
  literally in the order the checks expect — verify against the check files).
- IDs: repo ids, issue ids, comment ids are sequential integers from per-store
  counters starting at 1 (or the scheme the checks require — verify in your
  check file and note any deviation here).

## Auth

- The bearer token is read once at startup from env `MAKEFUN_SHOP_TOKEN`
  (the suite sends `Authorization: Bearer <that token>` on every API call).
- `GET /healthz` takes no auth. Every other surface requires the exact token;
  missing or wrong token → `401` with GitHub-style JSON body
  `{"message":"Bad credentials","documentation_url":"https://docs.github.com/rest"}`
  (verify the exact body/status in checks-rest.ts / protocol checks; the
  protocol worker owns the final wording — update this doc if it differs).
- The token's user is `store.viewer` (type User). **CORRECTION (graphql/mcp
  worker, 18 Nov 2026 — the check file wins over the default below): the
  suite's scenario is built from the fixed seed `SCENARIO_SEED =
  0x6a09e667f3bcc909n` in kit `program/env/src/wire.ts`, and its viewer is
  `users[0]`, i.e. login `"adaiversen"`, id `1000`, name `"ada iversen"`,
  email `"adaiversen@example.invalid"` (verified by running the kit's
  `buildScenario()` locally). The GraphQL check `viewer-login` compares
  `viewer.login` to `scenario.viewer.login`, and the MCP checks fall back to
  the same login for the repository owner — so `store.viewer` MUST be that
  user, not the `"forge"` default below.** Every surface uses `store.viewer`
  — never hardcode a login elsewhere. (Correction confirmed by the store
  worker 18 Nov 2026: `store.ts` sets `store.viewer` to exactly that user;
  there is no `"forge"` fallback — the old default line is deleted.)

## Types (store.ts exports these)

```ts
export type Sha1 = string; // 40 lowercase hex chars
export interface User {
  id: number; login: string; name: string; email: string;
  type: 'User' | 'Organization';
  avatar_url: string; html_url: string; url: string;
}
export interface GitObject { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer; }
export interface Label { id: number; name: string; color: string; description: string; }
export interface IssueComment { id: number; body: string; user: string; created_at: string; updated_at: string; }
export interface Issue {
  id: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; locked: boolean;
  labels: string[]; assignees: string[]; user: string;
  created_at: string; updated_at: string; closed_at: string | null;
  comments: IssueComment[];
}
export interface Pull {
  id: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; merged: boolean; mergeable: boolean;
  head: { label: string; ref: string; sha: string };
  base: { label: string; ref: string; sha: string };
  user: string; created_at: string; updated_at: string;
  merged_at: string | null; merge_commit_sha: string | null;
  // files of the PR are derived from the git store (diff head-base); do NOT
  // snapshot file lists at creation — compute on read so merges stay correct.
}
export interface Repo {
  id: number; owner: string; name: string; full_name: string;
  description: string; private: boolean; default_branch: string;
  created_at: string; updated_at: string; pushed_at: string;
  objects: Map<Sha1, GitObject>;          // all git objects, keyed by SHA-1
  refs: Map<string, Sha1>;                // full refname ('refs/heads/main') -> sha
  issues: Map<number, Issue>; nextIssue: number;
  pulls: Map<number, Pull>; nextPull: number;
  labels: Map<string, Label>;             // by label name
  nextCommentId: number;
}
export class Store {
  viewer: User;
  users: Map<string, User>;               // by login
  repos: Map<string, Repo>;               // key `${owner}/${name}`
  clock: { nowIso(): string; tick(): void };
  nextRepoId: number; nextLabelId: number;
  getRepo(owner: string, name: string): Repo | undefined;
  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean; defaultBranch?: string }): Repo;
  // object helpers live here (used by git + REST contents + GraphQL):
  // putObject/getObject/hasObject take an optional `repo` (3rd/2nd arg): with it the lookup is
  // scoped to repo.objects, without it to the store-level `objects` map. git.ts reads
  // repo.objects ONLY, so REST contents/merges write BOTH (repo-scoped first, then
  // store-level; content-addressed, idempotent) and REST readers check repo.objects
  // first, then the store-level map (same order as graphql.ts's getObject helper —
  // GraphQL's own writers are store-level only). Readers that must see both check
  // repo.objects first, then the store-level map.
  putObject(type: GitObject['type'], data: Buffer, repo?: Repo): Sha1;   // SHA-1 = sha1(`${type} ${len}\0` + data)
  getObject(sha: Sha1, repo?: Repo): GitObject | undefined;
  hasObject(sha: Sha1, repo?: Repo): boolean;
  // Issue ids are per-repo (id === number); there are NO store-global nextIssueId/nextPullId.
  createIssue(repo: Repo, fields: { title: string; body?: string; labels?: string[]; assignees?: string[]; user?: string }): Issue;
  addIssueComment(repo: Repo, issueNumber: number, body: string, user?: string): IssueComment | undefined;
  // createPull takes the full head/base objects (label/ref/sha resolved by the caller).
  createPull(repo: Repo, fields: { title: string; body?: string; head: { label: string; ref: string; sha: string }; base: { label: string; ref: string; sha: string }; user?: string }): Pull;
  // ---- RESOLUTION (18 Nov 2026): the close / pull-request-create / merge / files / mergeable ----
  // operations the graphql/mcp worker requested here were NOT added to store.ts. The store worker
  // ships createIssue/addIssueComment/createPull above; the REST worker implements close, PR
  // creation, squash-merge, file diff and mergeability as LOCAL helpers in rest.ts, and the
  // GraphQL worker mirrors those exact semantics as `*InStore` helpers in graphql.ts (same
  // squash-merge commit bytes, same merge-base diff, one clock tick per mutation), imported by
  // mcp.ts. Do NOT re-add these to store.ts without telling rest+graphql+mcp first — three
  // copies of the merge must stay byte-identical.
}
```

## Rules for every worker

- The store starts EMPTY (no pre-seeded repos/users/issues). The suite creates
  everything through the entry's own surfaces; the scenario data (names, paths,
  blob bytes) arrives inside the suite's requests.
- Every mutating REST/GraphQL/MCP/git operation goes through `Store` methods
  where they exist (createRepo/createIssue/addIssueComment/putObject/updateRef).
  The operations store.ts does not provide — close issue, PR create, squash
  merge, PR file diff, mergeability — live as local helpers in rest.ts and
  graphql.ts (mcp.ts imports graphql.ts's); the two copies must stay
  semantically identical (same merge commit bytes, same merge-base diff, one
  clock tick per mutation). Do not mutate `repo.objects` / `repo.refs` /
  `repo.issues` ad hoc outside those helpers.
- Responses: `Content-Type: application/json; charset=utf-8`, JSON body +
  trailing `\n` (starter `sendJson` style). Unknown routes/methods: `404`
  `{"message":"Not Found"}` (JSON, never HTML).
- `X-GitHub-Request-Id` header: present and non-empty on every API response
  (deterministic value, e.g. a per-process counter formatted as hex — never
  random). Verify the exact expectation in the protocol checks.
- Pagination: `Link` header with rel="next"/"last" etc. when the checks require
  it; default page size 30, `?page=&per_page=` honored.
- Keep hot paths allocation-light: the perf workloads are 2000 sequential
  issue GETs (~1.38 ms each at T_ref) and 200 sequential issue POSTs
  (~1.74 ms each). Route matching must be O(1)-ish (precompiled route table,
  no regex per request if avoidable); JSON serialization via a single
  `JSON.stringify` of a prebuilt object; avoid per-request Map re-creation.
- If a check file contradicts this doc, the CHECK FILE wins — update this doc
  with the correction and a one-line note so the other workers see it.

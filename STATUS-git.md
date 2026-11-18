# STATUS-git.md — store + git worker (18 Nov 2026)

Owner files: `store.ts`, `git.ts`, `pack.ts`. Nothing else in the repo was
touched by this worker. No git commits made (coordinator commits).

## Files

- `store.ts` — the ONE `Store`: `User/Repo/Issue/Pull/Label/GitObject`,
  logical clock (base `2026-11-14T06:30:00.000Z`, +1s per mutation),
  `putObject/getObject/hasObject` (SHA-1 `sha1("<type> <len>\0" + data)`),
  `createRepo/getRepo/deleteRepo`, ref updates with fast-forward checks
  (`updateRef`/`deleteRef`, reason `non-fast-forward`), `isAncestor`,
  `peelToCommit`, `reachable`, plus `createLabel/createIssue/
  addIssueComment/createPull` helpers for the REST/GraphQL/MCP workers.
  Viewer is the scenario viewer: login `adaiversen`, id 1000, name
  `ada iversen`, email `adaiversen@example.invalid` (see STORE_API.md
  correction — the old `"forge"` default is deleted, no fallback).
- `pack.ts` — pkt-line codec, object model (parse/build commit/tree/tag),
  `collectReachable`, packfile read (v2/v3, OFS_DELTA + REF_DELTA with
  `applyDelta`, trailer checksum) and write (plain objects, sorted by oid).
- `git.ts` — smart HTTP, `handleGit(req, res, ctx)` per INTEGRATION.md
  (ctx = `{ store, token, requestId, path, query, method, json, readBody,
  authed }`; auth + `X-GitHub-Request-Id` are app.ts's job). Legacy
  `handleGit(req, res, store, { token })` still accepted (test harness).
  Routes: `GET /{owner}/{repo}.git/info/refs` (v2 + v0, both services),
  `POST git-upload-pack` (v2 ls-refs/fetch, v0 fetch),
  `POST git-receive-pack` (v0). Unknown repo → 404 JSON; malformed
  request → 400, server stays up.

## Design decisions (pack)

- **No delta encoding when generating packs** (plain objects only). The
  suite's own client sends plain packs, the perf workloads are 1–3 objects
  per operation, and plain packs are the fastest correct choice. Delta
  *decoding* is fully implemented (real `git push` sends OFS deltas —
  verified with git 2.43.0).
- **Determinism**: generated packs sort objects by oid; advertisements,
  ls-refs answers and packs are cached per `repo.version` (bumped by every
  store ref change); identical clones produce byte-identical packs
  (verified). No `Date.now()`/`Math.random()`/random bytes anywhere in
  these files; commit objects are stored verbatim.
- **Fetch object selection**: depth-limited closure of the wants minus the
  objects the client holds (haves, cut off at its shallow boundaries).
  `shallow` = included commits whose parents were cut off; old boundaries
  now included are reported `unshallow`. `deepen-relative` (real git's
  `--deepen`) and `include-tag` are supported. Receive-pack validates a
  pack by checking only the pack objects' *direct* references (O(pack),
  not O(history) — every stored object's references were validated when
  stored); objects are stored even when a ref update is refused, as real
  receive-pack does; refusals are per-ref `ng <ref> non-fast-forward`.
- **Caching**: per-repo WeakMap cache keyed by `repo.version`:
  advertisements (v2/v0 × service), ls-refs answers (per args), packs (per
  sorted oid list). A push invalidates via the version bump.

## Test results (local, 18 Nov 2026)

Harness: `~/workspace/makefun-github-clone/repo-test/` (server.ts =
test server routing git.ts + a minimal REST create/delete stub;
run-checks.ts, bench.ts, app-test.ts, probe.ts). All run with
`node --experimental-strip-types` on Node 24.22.1.

- **Kit's real 30 git checks (`checks-git.ts`, GIT_CHECKS): 30/30 PASS**,
  twice: through the local test server and through the real
  `createApp()` from repo `app.ts` (auth + ctx + request-id plumbing).
- **TypeScript strict: 0 errors** (`tsc --noEmit`, TS 5.6.3 + @types/node 22).
- **git CLI 2.43.0** (real git, token via `http.extraHeader`): clone
  empty repo ✓; push initial commit ✓; clone non-empty + `git fsck
  --strict` exit 0, README byte-identical ✓; second-commit push (delta
  pack) ✓; branch create/push/delete ✓; tag push + `ls-remote` ✓;
  shallow `--depth 1` clone (1 commit, fsck 0) ✓; `fetch --deepen=1`
  (1→2→3 commits) ✓; `fetch --unshallow` (4 commits, `.git/shallow`
  removed) ✓; plain `fetch` on a shallow clone stays shallow ✓;
  divergent push refused `non-fast-forward`, repo intact ✓.
- **Bench-style perf** (same-process client+server on this 1.5-CPU VM;
  production runs env+entry in separate 2-CPU containers, so treat these
  as pessimistic): push 200 sequential = **3.19 ms/push** (target <4,
  T_ref 8.2); clone 50 concurrent shallow, 3 rounds = **4.06 / 3.20 /
  2.01 ms/clone** (target <3, T_ref 5.3; round 1 includes JIT warmup —
  the real bench runs 5 warmup clones first). Raw endpoint latency
  (separate processes): info/refs ~0.6–1.2 ms, ls-refs ~1.1 ms,
  fetch depth-1 ~0.8 ms, receive-pack POST ~1.4 ms; bare HTTP round-trip
  on this VM is ~0.6–1.0 ms, i.e. the server is near the environment floor.

## Check confidence

- Confident PASS (verified by the kit checks themselves, 30/30):
  advertise-v2, advertise-receive-pack, advertise-headers,
  unknown-repo-404, ls-refs, ls-refs-prefix, clone-empty,
  push-first-commit, clone-object-hashes, clone-blob-bytes,
  clone-tree-entries, clone-commit-bytes, clone-annotated-tag,
  fetch-incremental, fetch-nothing-new, fetch-shallow-depth1,
  fetch-shallow-deepen, fetch-shallow-new-tip, push-update-ref,
  push-create-branch, push-delete-branch, push-non-fast-forward,
  push-mixed-report, push-delete-tag, push-100-files, pack-integrity,
  pack-deltas (passes with 0 deltas — the check allows that),
  sideband-framing, push-sideband-report, repo-survives-errors.
- Perf risk **resolved by the full grade-local run** (see below):
  push 1.96 ms/op (50/50 pts), clone 1.69 ms/clone (46/50 pts) in the
  real trial harness — both well under the <4 ms / <3 ms targets. The
  4 points lost on clone are the only perf gap; the server path is
  already cache-heavy, so further gains would need fewer round-trips
  (client-driven) rather than server work.
- No risk known from `pack-deltas`: the check only verifies delta objects
  *when the server sends them*; we send none, which it explicitly allows.

## Bugs found by testing against real git (all fixed)

1. v0 advertisement had **no trailing flush packet** → real git died
   with "remote end hung up upon initial contact" on push. Fixed:
   v0 ads now end with flush. (Kit client didn't need it — it reads to
   stream end.)
2. v2 fetch always sent an `acknowledgments` section → real git clone
   (no haves) died with "expected 'packfile', received
   'acknowledgments'". Fixed: the section is sent only when haves exist.
3. v2 fetch sections were separated by **flush** → real git fetch with
   haves died with "expected packfile to be sent after 'ready'". Fixed:
   sections are separated by DELIM (`0001`); only the last ends with
   flush.
4. `deepen-relative` (real `git fetch --deepen=N`) was treated as an
   absolute depth → deepen returned no pack. Fixed: relative deepen walks
   to the old boundary, then N generations past it; `include-tag` also
   implemented. Absolute `deepen` now also walks past the old boundary
   (needed for `--unshallow` = deepen 2147483647); the boundary only
   stops the walk when no deepen was requested (plain fetch on a shallow
   clone stays shallow — verified).

## Ambiguities / decisions recorded

- `STORE_API.md`'s `putObject(type, data)` has no repo argument; it is
  implemented with an optional `repo?` (repo-scoped when given — git.ts
  always passes it; the no-repo path uses a store-level map for REST/
  GraphQL helpers). `Repo` gained a `version` counter (cache
  invalidation) and `Store` gained `deleteRepo`, `updateRef`,
  `deleteRef`, `isAncestor`, `peelToCommit`, `reachable`,
  `createLabel/createIssue/addIssueComment/createPull` — all documented
  in the code; none of it contradicts the check files.
- `Store.createRepo` ticks the clock once; each successful `updateRef`/
  `deleteRef` ticks once and stamps `pushed_at`. A multi-ref push therefore
  ticks once per accepted ref — deterministic for a fixed request sequence.
- Old-value mismatch on update/delete is reported as
  `non-fast-forward` (same reason string the checks assert for the
  non-FF case); no check distinguishes it.
- A delete of a nonexistent ref reports `ng <ref> ref does not exist`;
  creating an existing ref reports `non-fast-forward`. Neither is
  exercised by the checks.
- `ls-refs` with a `ref-prefix` filter omits HEAD (its name matches no
  `refs/...` prefix) — required by `ls-refs-prefix`, which inspects the
  server's raw list.

## Changes to STORE_API.md

- Viewer default corrected (already noted by the graphql/mcp worker, now
  confirmed + the stale `"forge"` fallback line deleted): viewer is
  `adaiversen`, id 1000, `ada iversen`, `adaiversen@example.invalid`.
  No other STORE_API.md changes.

## For the coordinator / integration worker

- `handleGit` now takes the INTEGRATION.md ctx (`handleGit(req, res,
  ctx)`); the old `(req, res, store, { token })` form still works for
  local harnesses. `app.ts` already calls it with ctx — verified 30/30
  through `createApp()`.
- **Full `grade-local --worktree` (18 Nov 2026, this worktree): score
  991/1000 — feature 600/600, agent 200/200, perf 191/200.
  All 120 checks pass (git 30/30, graphql 20/20, issues 15/15, mcp 15/15,
  protocol 5/5, pulls 20/20, repos 15/15). Perf: push p50 392 ms/200
  ops = 1.96 ms/push → 50 pts; clone p50 84 ms/50 ops = 1.69 ms/clone
  → 46 pts; read 47 pts; write 48 pts; perf_p50_us 226209. Log:
  `~/workspace/makefun-github-clone/repo-test/grade-local-worktree.log`;
  kept trial
  `/home/hatch/.makefun/trials/github-core-clone-01/01a1edab-6b1e-71c4-b989-f37788aa62fa/`.

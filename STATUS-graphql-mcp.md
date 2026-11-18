# STATUS — GraphQL v4 + MCP (worker: graphql+mcp)

Kompetisi: `github-core-clone-01`. Repo: `~/workspace/makefun-github-clone/repo/`.
Terakhir diperbarui: 2026-11-18 ~15:10 WIB (setelah Run 2 lokal).

## File milik worker ini

- `graphql.ts` (~65 KB) — POST `/api/graphql`. Handler `handleGraphql(req, res, ctx)`
  sesuai `INTEGRATION.md` (ctx: store/token/requestId/path/query/method/json/readBody/authed;
  return false untuk non-POST / store null; auth + `X-GitHub-Request-Id` urusan app.ts).
  Core murni `executeGraphQL(store, body)` dipakai tes (single op / batched array).
- `mcp.ts` (~18 KB) — POST `/mcp`, JSON-RPC 2.0 Streamable HTTP revisi 2026-07-28.
  Handler `handleMcp(req, res, ctx)`; core murni `executeMcp(store, request)`.
- `STORE_API.md` — hanya koreksi/koordinasi (lihat bawah). Tidak ada store baru.

## Yang diimplementasikan vs yang checks minta

### GraphQL (20/20 checks direplikasi lokal — semua PASS, lihat "Hasil tes")
- Parser minimal: operation query/mutation, alias, arg literal + $variables (+ default),
  fragment inline + named (1 level), `__typename`, string blok + escape, enum, list,
  input object, operation name.
- Query: `viewer`, `repository(owner,name)`, `node(id)`. `Query.search` TIDAK
  diimplementasikan — tidak ada di checks (sengaja).
- Repository: id, databaseId, name, nameWithOwner, owner, defaultBranchRef,
  viewerPermission (`ADMIN`), hasIssuesEnabled (true), issue, issues, pullRequests,
  pullRequest.
- Issue: id, number, title, body, state, author, labels, comments, createdAt,
  updatedAt; koneksi issues: filter states, orderBy CREATED_AT/UPDATED_AT/COMMENTS
  ASC/DESC (tiebreak number), paginasi cursor.
- PullRequest: id, number, title, body, state, headRefName, baseRefName, mergeable,
  merged, files (diff merge-base tree → head tree, path terurut), author, labels,
  comments.
- Mutation: `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`
  (SQUASH), `addComment` (+ payload `commentEdge.node.id/body`).
- Introspeksi: `__schema` / `__type` / `__typename` untuk Issue, PullRequest,
  Repository, SearchType (enumValues memuat ISSUE), dan tipe pendukung.
- Global id opaque base64 (`Repository:<dbId>`, `Issue:<repoId>:<number>`,
  `PullRequest:<repoId>:<number>`, `IssueComment:<repoId>:<issue>:<commentId>`,
  `User:<login>`), cursor base64 (`cursor:<Kind>:<number>`). Stabil antar baca.
- Error: field tak dikenal → HTTP 200 + `errors[]` menyebut nama field
  (`Cannot query field "noSuchFieldOnViewer" on type "Viewer".`), `data: null`;
  repository tak dikenal → `data.repository: null` tanpa errors; JSON rusak →
  400 `{"message":"Problems parsing JSON"}`; batching: array JSON → jawaban
  berurutan.
- Helper `*InStore` (dieksport untuk mcp.ts, semantik identik dengan rest.ts):
  `getObject` (repo.objects dulu, lalu store-level), `putGitObject` (store-level),
  `parseCommitSafe`/`parseTreeSafe`, `treeShaOfCommit`, `fileMapOf`, `walkCommits`,
  `mergeBaseOf`, `diffTrees`, `mergeWouldConflict`, `treeFromFileMap`,
  `epochOf`, `serializeMergeCommit`, `closeIssueInStore`, `createPullInStore`,
  `mergePullInStore`, `pullFilesInStore`, `pullMergeableInStore`.
  Merge squash dipakai untuk SEMUA metode (MERGE/SQUASH/REBASE), seperti REST.

### MCP (15/15 checks direplikasi lokal — semua PASS)
- `server/discover`: supportedVersions
  `['2026-07-28','2025-11-25','2025-06-18','2025-03-26','2024-11-05']`,
  capabilities `{tools:{}}`, serverInfo `{name:'github-core-clone', version:'0.1.0'}`
  (top level + `_meta['io.modelcontextprotocol/serverInfo']`).
- `initialize`: echo versi yang diminta bila didukung, else -32602 + `data.supported`.
- `notifications/*` → 202 kosong. `ping` → `{}`. Tidak pernah mengeluarkan session id.
- `tools/list`: statis (byte-identical): `create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request` — deskripsi + inputSchema
  `type: object` semua terisi.
- `tools/call`: hasil `content: [{type:"text", text: JSON.stringify(...)}]`;
  tool tak dikenal → -32602; argumen hilang/tak valid atau repo tak ada → hasil
  `isError: true`; `create_repo` gagal bila repo sudah ada. Efek terlihat via REST
  (satu Store yang sama). `create_issue` memakai `store.createIssue`;
  create/merge PR memakai `createPullInStore`/`mergePullInStore` dari graphql.ts.
- Body non-JSON → HTTP 400 + JSON-RPC -32700 (check file menang atas bentuk
  `{"message"}` di INTEGRATION.md untuk /mcp).

## Hasil tes lokal

Runner: `/tmp/gql-test/run-tests.ts` — server `createApp` in-process
(MAKEFUN_SHOP_TOKEN=test-token-123), kit `GraphQLClient` + `McpClient`,
push git via CLI sungguhan (author/committer date tetap 2026-11-14T06:30:00Z),
mereplikasi ke-20 check GraphQL + ke-15 check MCP dari kit.

- **37/37 PASS** (run terakhir 2026-11-18, terhadap salinan repo + adapter
  git.ts khusus-tes saja — lihat "Blokir dari worker lain").
  Termasuk: `graphql.pull-request-files`, `graphql.merge-pull-request`,
  `mcp.create-pull-request`, `mcp.merge-pull-request`, `mcp.rest-parity`,
  `graphql.issues-pagination`, `graphql.batched-operations`,
  `graphql.global-id-stability`, `mcp.parse-error`, `mcp.auth-required`.
- Smoke test awal (5 probe: healthz, viewer, MCP discover, JSON rusak 400,
  tanpa-auth 401): semua PASS.
- Debug isolasi (`/tmp/gql-test/dbg2.ts`, `dbg3.ts`): helper PR (create, files,
  mergeable, squash-merge) benar untuk objek store-level MAUPUN repo.objects
  (hasil merge commit `b19bfdaed9d032fd2f5aa61f2d76d68a4bfd7a0c` di kedua jalur).
- Type check: `tsc --noEmit --strict` (TS 5.6.3, @types/node 22, di /tmp/tscheck)
  atas `graphql.ts` + `mcp.ts` → **0 error**.
- Determinisme: tidak ada `Date.now()`/`new Date()`/`Math.random()`/
  `crypto.randomBytes()` di response/state; timestamp hanya dari `Store.clock`;
  satu tick per mutasi.

## Blokir dari worker lain (BUKAN bug file saya — perlu perbaikan mereka)

1. **git.ts — handler contract salah (BLOKIR UTAMA, masih ada di repo).**
   `handleGit(req, res, store: Store, opts)` memakai argumen ke-3 sebagai Store
   langsung, padahal app.ts (INTEGRATION.md) memanggilnya dengan objek Ctx
   → semua route git 400 `store.getRepo is not a function`.
   Tanpa ini, suite tidak bisa push branch → check GraphQL PR (9–12) gagal total.
   Perbaikan untuk pemilik git.ts: terima `(req, res, ctx)` dan ambil `ctx.store`
   (+ `ctx.token`). Bukti lokal: dengan adapter satu baris di SALINAN /tmp saja,
   semua 37 tes lolos — file saya tidak berubah.
2. **rest.ts — `getObj`/`hasObj` rekursi-diri (SUDAH DIPERBAIKI pemiliknya
   saat sesi ini berjalan).** Versi lama: `return getObj(store, repo, sha) ?? ...`
   → `RangeError: Maximum call stack size exceeded` di POST /pulls, GET /pulls/:n,
   PUT /contents. Versi repo saat ini sudah benar
   (`store.getObject(sha, repo) ?? store.getObject(sha)`). Pelajaran: salinan
   /tmp yang dibuat sebelum perbaikan mereka menguji rest.ts basi — selalu
   re-sync sebelum menyimpulkan.
3. app.ts di repo saat run terakhir: `loadHandler`/`loadStore` sesuai
   INTEGRATION.md; tidak ada masalah dari sisi saya.

## Perubahan STORE_API.md (oleh worker ini)

1. Koreksi viewer: `store.viewer` HARUS `adaiversen`/1000 (bukan `"forge"`/1).
2. Blok "metode Store yang diminta" diganti catatan RESOLUTION: metode itu
   TIDAK ditambahkan ke store.ts; rest.ts + graphql.ts mengimplementasikannya
   lokal dengan semantik identik; mcp.ts mengimpor dari graphql.ts. Jangan
   tambah ulang ke store.ts tanpa memberi tahu rest+graphql+mcp.
3. Koreksi ke signature nyata store.ts: `putObject/getObject/hasObject`
   memakai argumen opsional `repo` (store-level `objects` vs per-repo
   `repo.objects`); `createIssue(repo, fields:{title,body?,...})`;
   `addIssueComment(repo, issueNumber, body, user?)`;
   `createPull(repo, fields:{title,body?,head:{label,ref,sha},base:{...},user?})`;
   id Issue/Pull per-repo (`id === number`), tanpa counter global.

## Keputusan ambigu (dicatat)

- Merge method: squash untuk SEMUA metode (ikuti REST), bukan hanya SQUASH.
- MCP parse-error: bentuk JSON-RPC (-32700, HTTP 400) — check file menang atas
  INTEGRATION.md.
- `Query.search` tidak diimplementasikan — tidak ada di checks.
- `mergeable` = `UNKNOWN` untuk PR merged/closed/tanpa base/tanpa merge-base.
- Lookup objek dua peta (repo.objects → store-level) karena git.ts menyimpan
  objek push di repo, REST/GraphQL di store-level.
- Tidak ada `Date.now()`/`Math.random()`; satu tick clock per mutasi.

## Yang belum / risiko sisa

- Belum ada run grading resmi (Run 2) — menunggu git.ts diperbaiki pemiliknya
  dan koordinator menjalankan suite kit.
- Risiko rendah: perbedaan byte merge commit vs ekspektasi suite bila suite
  membandingkan hash merge commit secara eksak (suite hanya cek REST
  `merged:true` + `state: closed`, jadi aman sejauh yang terbaca di checks).
- Tidak ada commit git oleh worker ini (koordinator yang commit).

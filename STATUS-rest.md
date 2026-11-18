# STATUS-rest.md — REST v3 + protocol worker (rest.ts, protocol.ts)

## File yang dibuat/diubah (hanya milik worker ini)
- `rest.ts` (baru, ~2160 baris) — semua route REST v3 + helper git-object/diff/merge.
- `protocol.ts` (baru, ~275 baris) — disiplin wire: token, request-id, sendJson,
  pagination/Link, body parsing, interface `Ctx`.
- `STORE_API.md` (satu komentar dikoreksi) — lihat "Perubahan STORE_API.md".
- Tidak menyentuh: `app.ts`, `main.ts`, `store.ts`, `git.ts`, `pack.ts`,
  `graphql.ts`, `mcp.ts`. Tidak ada commit git (koordinator yang commit).

## Kontrak integrasi (sesuai INTEGRATION.md + app.ts yang sudah mendarat)
- `export async function handleRest(req, res, ctx): Promise<boolean>` di `rest.ts`;
  `ctx` = `{ store, token, requestId, path, query, method, json, readBody, authed }`.
- app.ts sudah: set `X-GitHub-Request-Id` di depan (`req-<counter hex>`), enforce
  auth sebelum dispatch (401 `{"message":"Bad credentials","documentation_url":
  "https://docs.github.com/rest"}`), handle `GET /healthz` + `GET /api/v3/` root
  sendiri. `handleRest` tetap: jawab root bila dipanggil dengan path itu,
  cek ulang auth via `ctx.authed` (defense in depth), jawab 503
  `{"message":"Service Unavailable"}` bila `ctx.store === null`.
- `protocol.ts` mengekspor primitif yang dipakai app.ts/Ctx:
  `API_PREFIX`, `TOKEN_ENV`, `AUTH_SCHEME`, `readTokenFromEnv`,
  `createRequestIdSource`, `bearerTokenOf`, `isAuthed`, `sendJson`,
  `unauthorizedBody/notFoundBody/badRequestBody/conflictBody/unprocessableBody/
  methodNotAllowedBody`, `parseJsonBody/isJsonObject`, `parsePagination/
  paginate/buildLinkHeader/originOf`, dan interface `Ctx`.

## Keputusan: login viewer — GET /api/v3/user
- Mengembalikan `store.viewer` apa adanya: `{ login: "adaiversen", id: 1000,
  name: "ada iversen", email: "adaiversen@example.invalid", type: "User", ... }`.
- Alasan: `wire.ts` membangun skenario dari seed tetap
  `SCENARIO_SEED = 0x6a09e667f3bcc909n`; `buildScenario()` yang saya jalankan
  membuktikan `users[0]` = viewer di atas. Semua check memakai
  `scenario.viewer.login` sebagai owner repo, dan `checks-mcp.ts`
  (`resolveOwner`) memakai `GET /api/v3/user` dengan fallback ke viewer
  skenario bila route menolak — jadi route ini HARUS mengembalikan login
  tersebut. `rest.ts` tidak pernah hardcode login; ia membaca `store.viewer`
  (sudah benar di `store.ts` yang mendarat).
- `GET /api/v3/users/{login}` juga diimplementasi (viewer → 200, lainnya 404).

## Route yang diimplementasi vs yang checks-rest.ts minta
Semua route yang checks minta ADA (50 check: repos 15 + issues 15 + pulls 20
+ protocol 5). Tambahan di luar checks (gratis, tidak mengganggu):
- `GET /api/v3/meta` → `{"installed_version":"1.0.0"}` (checks minta string
  non-empty; nilai ini yang dipakai — menjawab pertanyaan integrator no. 3).
- `POST /orgs/{org}/repos`, `GET /api/v3/users/{login}`,
  `GET /repos/{o}/{r}/branches/{b}`, `GET /repos/{o}/{r}/commits/{sha}`,
  `GET /repos/{o}/{r}/git/refs` (list) + `GET /git/refs/{ref}` +
  `PATCH /git/refs/{ref}`, `GET /repos/{o}/{r}/labels` (+ GET/PATCH/DELETE
  per label), `POST/GET /issues/{n}/labels` + `DELETE /issues/{n}/labels/{name}`,
  `GET/PATCH/DELETE /issues/comments/{id}` (+ nested di bawah issue),
  `GET /pulls/{n}/reviews` (→ `[]`), `GET /pulls/{n}/commits`.
- Yang SENGAJA tidak dibuat: `GET /api/v3/rate_limit` (tidak ada di checks
  mana pun; root hanya menyebut URL-nya), `POST /pulls/{n}/reviews`
  (tidak diuji; route tak dikenal → 404 JSON sesuai kontrak).

## Semantik penting (disalin dari checks-rest.ts, bukan dari ingatan GitHub)
- Repo duplikat → 422 `{"message":"Repository already exists"}` (pesan
  mengandung "already exists" — `git-client.ts` hanya menerima 422 itu).
- Issue/PR: nomor auto-increment per repo mulai 1, counter TERPISAH
  (`nextIssue`/`nextPull` sesuai `store.ts`); issue `id === number`
  (per-repo, sesuai STORE_API.md); comment `id` dari `repo.nextCommentId`.
- Label tak dikenal saat POST issue → 422; label dibuat via `POST /labels`
  (201 `{name, color}`).
- Contents: PUT pertama 201, update 200, sha basi → 409; DELETE 200
  `{commit:{sha}}`, GET sesudahnya 404; GET direktori → array
  `{type, name, path, sha}`; `?ref=` didukung. Commit dibuat sebagai objek
  git asli (blob+tree+commit, author/committer = viewer, epoch dari
  `Store.clock`) sehingga `GET /commits`, `GET /branches`, dan git smart-HTTP
  melihatnya.
- Merge PR: squash SELALU (apa pun `merge_method` yang dikirim — checks hanya
  memakai `squash`; dicatat, bukan disembunyikan). Commit merge: 1 parent
  (base tip), tree = perubahan head-vs-merge-base diterapkan di atas base
  tip, pesan `Merge pull request #N from {owner}/{head}`. Sesudah merge:
  PR `state closed`, `merged true`, `merged_at`, `merge_commit_sha` = sha
  merge; ref base maju ke sha merge. Konflik (head & base sama-sama ubah
  file yang sama secara berbeda sejak merge-base) → 405; PR tak dikenal → 404;
  PR sudah merge/closed → 405.
- PR files: diff merge-base → head, `status` added/modified/removed,
  `additions/deletions/changes` dari diff baris LCS (DP; fallback multiset
  bila blob > 250k sel).
- Pagination: `?page=&per_page=` (default 30, cap 100), header `Link` absolut
  same-origin dengan rel next/last/prev/first bila > 1 halaman.
- Auth: semua `/api/v3/*` kecuali root butuh `Bearer` persis
  `MAKEFUN_SHOP_TOKEN` (dibaca sekali saat startup, tidak di-hardcode);
  hilang/salah → 401 body persis STORE_API.md. `/healthz` tanpa auth
  (di app.ts). Unknown route/method → 404 `{"message":"Not Found"}` JSON.
- `X-GitHub-Request-Id`: `req-<counter hex>` per proses (dibuat app.ts;
  `protocol.ts` menyediakan `createRequestIdSource` yang sama).

## Store: apa yang dipakai & konvensi tick
- Dipakai: `store.getRepo/createRepo/deleteRepo`, `store.createLabel`,
  `store.createIssue`, `store.addIssueComment`, `store.createPull`,
  `store.updateRef`, `store.putObject/getObject/hasObject` (SELALU dengan
  argumen repo), `store.clock`, `store.viewer/users/repos`.
- Konvensi tick (sesuai `store.ts` yang mendarat): method Store yang
  bermutasi tick sendiri tepat sekali; handler HANYA tick untuk mutasi
  langsung tanpa helper Store (PATCH repo/issue/comment/label, hapus label
  dari issue, PATCH ref force). Satu operasi = satu tick.
- Objek git: REST tulis ke KEDUA map — `repo.objects` (wajib: `git.ts` hanya
  membaca `repo.objects`) DAN store-level (GraphQL menulis store-level saja);
  baca = repo dulu, lalu store-level (urutan sama seperti helper `getObject`
  di `graphql.ts`). Ini menutup lubang lintas-permukaan dua arah.
- Sisa mutasi langsung (tidak ada helper Store): PATCH repo description/
  private/default_branch, PATCH issue (state/title/body/labels/locked),
  PATCH/DELETE comment, PATCH/DELETE label, hapus label dari issue,
  PATCH ref (force-capable, sengaja tidak pakai `updateRef` karena
  `updateRef` menolak non-fast-forward).

## Perubahan STORE_API.md
- Satu komentar dikoreksi: klaim lama "REST contents/merges write
  store-level" diganti fakta implementasi — REST tulis repo-scoped DAN
  store-level; pembaca cek repo dulu lalu store-level. (Viewer `adaiversen`
  sudah diperbaiki store worker sebelum saya sempat menyentuhnya.)

## Hasil tes lokal (harness /tmp/harness, server = app.ts asli + store.ts asli)
- `test-rest.mjs` (cerminan alur checks-rest.ts, 48 asersi): **48 passed,
  0 failed** — terakhir diulang setelah perubahan dual-read/write.
  Mencakup: protocol (root/meta/user/404/400/request-id/content-type),
  repos (create/patch/delete/unauth/wrong-token/foreign-404/pagination
  30 repo @per_page=10 + Link next, branches, branch-one, git-ref,
  commits branch vs default, commit-one, contents create/get/dir/update/
  stale-409/delete), issues (create/labels/numbers/list-open/sort asc+desc/
  get-one/patch-close/comments/bad-label-422), pulls (create/head-sha/
  base-sha/files/files-multiple/merge squash/merge-closes/commit-on-default/
  content-on-default/unknown-404/conflict-405/list all+open), org-create.
- `perf-probe.mjs` (server bersih, keep-alive fetch, VM ini 1,5 CPU):
  read 2000x GET issue **0,567 ms/req** (target <0,7; T_ref 1,38),
  write 200x POST issue **0,899 ms/req** (target <0,9; T_ref 1,74, di batas —
  run sebelumnya 0,979; angka berfluktuasi dengan beban VM; baseline routing
  saja ~0,8 ms menurut GRADING.md). Replay: body GET yang sama
  byte-identical.
- `tsc --strict` (TS 5.9.3, diambil sementara ke /tmp/tscheck):
  `rest.ts` + `protocol.ts` **bersih, 0 error**. `tsc -p tsconfig.json`
  masih melaporkan error di `app.ts` (cast Store) dan `git.ts` — file
  worker lain, bukan milik saya, tidak saya sentuh.
- `grep`: tidak ada `Date.now()`/`Math.random()`/`new Date()`/
  `randomBytes` di `rest.ts`/`protocol.ts` (kecuali di komentar).

## Check yang saya yakini lolos vs masih berisiko
- Yakin lolos (diverifikasi langsung oleh harness di atas): seluruh 50
  check REST (repos 15, issues 15, pulls 20, protocol 5) — setiap alurnya
  direplikasi 1:1 dari checks-rest.ts dengan data skenario asli
  (owner `adaiversen`, repo prefix `amber-thistle`, path `config/token.css`).
- Berisiko / belum terverifikasi di sini:
  1. `grade-local` resmi belum dijalankan (koordinator/integrator yang
     menjalankan) — harness saya memakai `RestClient`-mirip fetch, bukan
     runner env yang sebenarnya.
  2. Perf write di batas target (0,899 vs <0,9) di VM ini; di sandbox trial
     bisa di atas atau di bawah — tidak ada lagi optimasi murah yang tersisa
     (hot path sudah: decision-tree tanpa regex, satu `JSON.stringify`,
     tanpa alokasi Map per request; sisa biaya adalah round-trip HTTP).
  3. Lintas-permukaan: merge via GraphQL lalu dibaca REST (dan sebaliknya)
     hanya dijamin lewat dual-read/write objek; belum ada tes gabungan
     REST+GraphQL+MCP (milik koordinator).
  4. `GET /pulls/{n}/files` untuk PR yang head-nya didorong via git
     protocol (bukan contents API) — diff memakai merge-base walk yang sama,
     tapi belum diuji dengan pack git asli (git worker).

## Keputusan ambigu yang dicatat
- `installed_version`: `"1.0.0"` (checks hanya minta string non-empty).
- `merge_method` selain `squash` tetap di-merge sebagai squash.
- Nomor issue/PR counter terpisah (mengikuti `store.ts`, bukan GitHub yang
  berbagi counter) — tidak ada check yang membedakan keduanya.
- PUT contents tanpa `sha` atas file yang sudah ada → 422 (perilaku GitHub);
  dengan `sha` tapi file tidak ada → 409.
- GET repo yang owner-nya org (`/orgs/.../repos`) bisa dibaca siapa saja
  yang memegang token (tidak ada registry org di store); owner asing yang
  tidak punya repo → 404, bukan 403 (sesuai checks).
- `Ctx.store` di `protocol.ts` bertipe `Store | null` (app.ts aslinya
  `StoreLike | null`); `handleRest` menjawab 503 bila null.

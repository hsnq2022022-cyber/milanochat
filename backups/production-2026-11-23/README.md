# Production backup — 2026-11-23

Backup of the **deployed** Supabase Edge Function sources for `api`, `meta-auth` and `channels`, plus the reviewed
security-hotfix copies derived from them, the dedicated test harness and the mutation-test runner.
Project: `nmhefwvhoholcjrbbila`. This branch is a record only: **nothing in this directory is deployed by it**, and as of
this commit **the hotfix files have not been deployed**.

## Production versions captured

Retrieved read-only through the Supabase management tooling (`get_edge_function`) on 2026-11-23, about 10:28–10:36 UTC.
Each function is a single flat `index.ts`, deployed with `verify_jwt = false` and no import map.

| Function | Version | Last updated (UTC) | Supabase bundle hash (`ezbr_sha256`) |
|---|---|---|---|
| `api` | v108 | 2026-10-04 20:13:56 | `b01ebb95a15ec91e32fa91d8cd0dc7126429a7ff462b976fc8b22d5d1dfb70f1` |
| `meta-auth` | v63 | 2026-10-10 18:40:51 | `9820a0cf374afe00c11a9c9ffad96d77b171677d445723a58e633e95aa78ad99` |
| `channels` | v112 | 2026-10-10 18:39:54 | `27f844bf6b6aee54abd0b5091b1a84e1de3a624036abd26025c967c0bdcdbd3a` |

The bundle hash is Supabase's hash of its own bundle, **not** of the source text.

## Files and SHA-256

| Path | SHA-256 |
|---|---|
| `originals/api.v108.index.ts` | `e0bd50831a5869bfe2f3a80d0e3719ebeef8d2ae0c08eb32225fbbdd7df92347` |
| `originals/meta-auth.v63.index.ts` | `d297196103c3861b34e369600158739b23387b35ffea8a041ba2d037ae32208e` |
| `originals/channels.v112.index.ts` | `af51a98a31de03cf3e442eaa5506dd674bee92dcc8ca5402fc1463bb8ac38855` |
| `originals/MANIFEST.txt` | `2a269a5e0b43d8d4f138711c6e43e699bf0a0cb3f09e1d2f1746b172b660e7b6` |
| `hotfix/api.v108.hotfix.index.ts` | `c9bc945ca7757566e7042333d3fdd49dbb88d5835cccc23dfe7f920d8646580b` |
| `hotfix/meta-auth.v63.hotfix.index.ts` | `e54bdc07ba1394e81f9f428df6cf95dca1e703a1506cf420de91b91dcd1fd043` |
| `hotfix/channels.v112.hotfix.index.ts` | `d9f503e7e5cc054b6d859de86e95422653415ef510efde97fe9e622e45406aa0` |
| `hotfix/WORKDIR-MANIFEST.txt` | `52151c9f752c3ef4e261b73f6c164f36930f594618f57d631a69706084dbec4d` |
| `tests/behavior.test.ts` | `1158727d60bcfa2ec7645454ce0a88a878eb43d730d105e360266f993921a3c1` |
| `hotfix-mutants/run.py` | `99f6d4e29d0515d5bf28577b00a9da6fc6110bca8952221cdb3ea37ff261f09e` |

`SHA256SUMS` in this directory lists every other file here (including this README) for `sha256sum -c SHA256SUMS`.

## Provenance

- `originals/*.index.ts`: the deployed source, transcribed from the management-tool output into files. Each file was
  written twice in two independent passes and the SHA-256 of both passes matched; the files also parse and pass Deno lint.
- `hotfix/*.hotfix.index.ts`: minimal edits of the originals, reviewed in detail. The changes only remove diagnostic
  endpoints and sensitive logging and replace raw error text with fixed messages or codes. The OAuth state format, signing,
  secrets selection, redirect derivation, callback paths, scopes and CORS are unchanged.
- `tests/behavior.test.ts` and `hotfix-mutants/run.py`: a differential test harness (original vs hotfix, stubbed network, fake
  values only) and the mutation runner. Recorded results from the review (not re-run for this backup): 29 tests passed,
  54 of 54 mutants caught.
- `originals/MANIFEST.txt` and `hotfix/WORKDIR-MANIFEST.txt` are the manifests written at the time, copied unchanged.

## Known limitations — read before relying on this backup

1. **Source fidelity is unproven.** The management API does not return a hash of the source text, so the originals are
   verified transcriptions, not demonstrated byte-for-byte copies of the deployed source. To prove equality, export the
   deployed functions with the Supabase CLI on a trusted machine (check `supabase functions download --help` for the exact
   syntax) and compare `sha256sum` against `originals/`.
2. **`hotfix/WORKDIR-MANIFEST.txt` is stale for `meta-auth`.** It records an earlier hash (`8a241dd5…`). The reviewed final
   hash is `e54bdc07…` (table above). The other two hashes in that file are current.
3. The manifests contain local scratch paths that no longer exist outside the original working environment.
4. `tests/behavior.test.ts` and `hotfix-mutants/run.py` hardcode those scratch paths, so they must be adapted to run elsewhere.
5. These files contain no credentials: they were read in full and pattern-scanned for tokens and private keys, and the
   test files use clearly fake values (`FAKE_*`). The sources do reference secret *names* (environment variable names).

## Using the backup

- Verify: `cd backups/production-2026-11-23 && sha256sum -c SHA256SUMS`.
- Roll back a function to its pre-hotfix version: deploy the matching `originals/*.index.ts` as a single `index.ts` with
  `verify_jwt = false` and no import map. Deploying restores whatever the original code exposes.

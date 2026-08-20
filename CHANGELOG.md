# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.3] - 2026-08-20

### Added
- `/sse` connect and denial logs carry `addr=<client address>`, so a leaked key can be
  traced to where it was used rather than only to when (#18). Measured first: the real
  client IP does survive Cloudflare → Tailscale Funnel → pod, arriving as
  `cf-connecting-ip`, while `req.socket.remoteAddress` is only the in-cluster proxy.
  Only `cf-connecting-ip` is trusted — Cloudflare *appends* to `x-forwarded-for`, so
  reading that would let a caller write an arbitrary address into the audit log.
- `MCP_LOG_HEADERS` (default off) dumps the header names present on a `/sse` handshake
  plus the values of address-carrying headers only. `x-brain-key` arrives on that same
  request, so a diagnostic printing every value would write live keys into the log it
  exists to secure.

## [0.8.2] - 2026-08-20

### Fixed
- **`setup.sh` no longer destroys existing AI client configuration** (#13). All three
  branches wrote their config with `cat > "$FILE"`, unconditionally replacing the file,
  so any other MCP servers, permissions or editor settings were silently lost with no
  warning and no backup. The reported case was `~/.claude/settings.json`, but
  `.vscode/settings.json` and `claude_desktop_config.json` had the identical defect.
  Configs are now merged (via `jq`, falling back to `node`), the original is backed up
  to `<file>.openbrain-backup-<timestamp>`, and when neither tool is available — or the
  file is not valid JSON — the file is left untouched and the snippet is printed for
  manual merge.
- `setup.ps1` merged `mcpServers` correctly but replaced the whole `mcp` key for VS
  Code, dropping any other servers configured under `mcp.servers`, and overwrote the
  file outright when it failed to parse. It now uses the same merge-and-back-up path.
- **The wizards generated client configs that could not connect.** Both wrote
  `http://localhost:8080/sse?key=<KEY>`, but 0.8.0 made `MCP_ALLOW_KEY_IN_QUERY`
  default to false and the generated `.env` never set it, so a fresh install produced a
  client that got 401. They now configure the `x-brain-key` header (and
  `mcp-remote --header` for Claude Desktop), and the generated `.env` documents the flag.

## [0.8.1] - 2026-08-20

### Added
- `openbrain_mcp_handshakes_total{source,outcome}` on `/metrics` — counts `/sse`
  handshakes by whether the key arrived as the `x-brain-key` header, as `?key=`, or
  not at all. Turning `MCP_ALLOW_KEY_IN_QUERY` off is a breaking change for anyone
  still using the URL form, and until now there was no way to tell whether anyone was:
  the MCP listener logged nothing per request.
- `/sse` connect and denial logs now carry `via=<source>` and a sanitised
  `client=<user-agent>`, so a query-param user can be identified and reconfigured
  rather than just counted.

### Fixed
- CI publishes images again. The `docker` job had failed on **every** push to master
  since 2026-03-25 with `invalid tag "ghcr.io/srnichols/OpenBrain:latest": repository
  name must be lowercase`; `build-and-test` passed throughout, which is why it went
  unnoticed. The image name is now lowercased, and it publishes to
  `ghcr.io/srnichols/openbrain/api` — a package created by this workflow, so
  `GITHUB_TOKEN` can write it and it inherits the repo's public visibility. The bare
  `ghcr.io/srnichols/openbrain` package predates the workflow, is not linked to the
  repo, and rejected the push with `permission_denied: write_package`.
- `deploy/on-prem/k8s/openbrain-api-deployment.yaml` now points at that GHCR image, so
  the manifest applies as-is without a private registry.

## [0.8.0] - 2026-08-19

### Added
- Named access keys (migration `004-add-access-keys.sql`): `access_keys` table storing
  a SHA-256 hash per key with `label`, `last_used_at`, `revoked_at` and `expires_at`.
  Each client gets its own key, revocable without rotating everyone else's.
- `npm run key` CLI — `mint`, `seed-legacy`, `list`, `revoke`. A minted key is printed
  once and only its hash is stored, so it can never be re-read.
- Per-key session attribution: `/sse` resolves the key to its row id and carries it on
  the session record, and connects are logged with the key label.
- `MCP_ALLOW_KEY_IN_QUERY` (default `false`) to opt into the `?key=` URL form.

### Fixed
- **Auth no longer fails open.** `if (mcpAccessKey && key !== mcpAccessKey)` allowed
  *every* request when `MCP_ACCESS_KEY` was unset, silently turning a public endpoint
  into an open read/write memory store. The server now refuses to start when neither a
  usable `access_keys` row nor `MCP_ACCESS_KEY` is configured.

### Changed
- **Breaking:** the key is no longer accepted as `?key=` in the URL unless
  `MCP_ALLOW_KEY_IN_QUERY=true`. Query strings land in access logs, proxy logs and
  browser history. Clients that can send `x-brain-key` should; ChatGPT and Claude
  Desktop connectors need the flag.
- `MCP_ACCESS_KEY` still authenticates as a fallback when no `access_keys` row matches,
  so existing deployments upgrade without a key swap. Run `npm run key -- seed-legacy`
  to fold it into the table.

## [0.7.4] - 2026-05-18

### Added
- Embedding-truncation warning: captures whose content exceeds the embedder's
  context window now return a `warnings[]` entry with reason `embedding_truncated`
  and tag `metadata.embedding_truncated = true` + `metadata.embedding_indexed_bytes`
  + `metadata.content_bytes`. Full content is still stored — only the embedding is
  truncated by the model. Callers know up-front that semantic search will not
  match passages past the cutoff and can choose to split into smaller captures.
- New `OPENBRAIN_EMBED_SAFE_BYTES` env var (default `6000`, tuned for Ollama
  `nomic-embed-text` 2048-token context) so deployments with larger-context
  embedders can raise the threshold.
- `/health` advertises new capability `embed-truncation-warning`.

## [0.7.3] - 2026-05-18

### Changed
- Ollama embedder now surfaces the upstream response body in error messages
  (previously only `400 Bad Request` was shown), making embed failures diagnosable end-to-end.
- Ollama embed requests send `truncate: true` explicitly to prevent oversized-content failures.
- Empty-vector responses from Ollama now throw a clear `no vector for this content` error
  instead of the opaque `Ollama returned empty embedding`. Includes `content_bytes` for debugging.

## [0.7.0] - 2026-05-16

### Added
- Provenance helpers: generated columns `source_file_hash` and `code_hash` on `thoughts`,
  partial indexes (`idx_thoughts_source_file_hash`, `idx_thoughts_code_hash`), and the
  `match_thoughts_by_source(source_hash, max_count, project_filter, include_archived)` RPC
  (migration `003-add-provenance-helpers.sql`).
- REST endpoint `GET /memories/by-source` for retrieving thoughts by source/origin
  (supports `source`, `project`, `created_by`, `include_archived`, `limit`).
- `created_by` user-attribution filter across list/search endpoints.
- `metadata.provenance` sub-object (`origin`, `original_id`, `imported_at`) for imported thoughts.

### Changed
- Documentation refresh: `docs/02-DATABASE-SCHEMA.md` (Provenance helpers section),
  `docs/04-MCP-SERVER.md`, and `README.md` updated for source-based lookup surface.
- Version bumped to `0.7.0` (pre-1.0 release line).

# Milkore — Progress (backend + product)

| Date | Phase | Summary | Status |
|---|---|---|---|
| 2026-11-12 | P0.1 | Repos (backend, app), CLAUDE.md files with API contract, docs skeletons | Done |
| 2026-11-12 | P0.2 | PRD, project plan + INR costs, architecture (Mermaid), roadmap, ADR-005…016 | Done |
| 2026-11-12 | B1 | NestJS 11 scaffold, env validation (zod), `{statusCode,message,data}` envelope + error filter, helmet, CORS, throttler, pino (redacted), Prisma, `/health`. DB check: PostgreSQL 18.7 local, PostGIS 3.7 installed by founder | Done |
| 2026-11-12 | D1–D4 | 3 migrations, 24 tables, GIST + trigram indexes, CHECK constraints | Done |
| 2026-11-12 | D5 | Base seed (8 categories, 6 units, super admin) + dev seed (15 vendors, 3 customers) | Done |
| 2026-11-12 | A1 | OTP login (HMAC, limits, test numbers), rotating refresh with reuse detection, guards, /me, account deletion | Done |
| 2026-11-12 | A2 | India Post proxy + DB cache + circuit breaker, Nominatim reverse geocoding (1 req/s, cache), customer location | Done |
| 2026-11-12 | A3 | Presigned uploads (S3/local), confirm with resize + EXIF strip; step-wise vendor onboarding, re-review rules | Done |
| 2026-11-12 | A4 | Catalogue, vendor products (paise, history, ownership 404s) | Done |
| 2026-11-12 | A5 | PostGIS discovery (radius ∨ PIN ∨ locality), products near, public vendor details (no phone) | Done |
| 2026-11-12 | A6 | Chat REST + Socket.IO gateway, idempotent send, read receipts, typing, calls, CommunicationPolicy (free) | Done |
| 2026-11-12 | A7 | Reports, support, admin auth (lockout, TOTP), approvals state machine, moderation, users, audit, admins | Done |
| 2026-11-13 | Q1 | 26 unit + 41 e2e tests on an isolated `<db>_test`; lint clean | Done |
| 2026-11-13 | Q3 | Dockerfile, docker-compose (PostGIS, Caddy), backup script, CI (lint/unit/e2e with PostGIS service, GHCR image), DEPLOYMENT.md | Done (not deployed) |
| 2026-11-13 | Q4/L1 | LAUNCH_CHECKLIST.md (signing, store listing, data safety, pilot playbook) | Docs done; founder actions pending |

## Verified results (latest run)

- `npm test`: 26/26 passed. `npm run test:e2e`: 41/41 passed. `npm run lint`: 0 problems. `tsc --noEmit`: clean.
- Live checks: India Post search (110001) and Nominatim reverse geocoding returned real data; admin dashboard login → stats → vendors through the proxy.

## Not done / founder actions

- AWS (Lightsail, S3, CloudFront), domain, MSG91 + DLT, Play Console, upload keystore — see `LAUNCH_CHECKLIST.md`.
- Sentry not installed yet (decide when deploying).
- `milkore_admin` has no GitHub repository yet (create `arvind3690/milkore_admin`, then push).

## Technical debt

- Catalog cache is per-process (10 min); fine for one instance.
- Socket.IO uses the in-memory adapter (single instance) — add the Redis adapter before scaling out (ADR-007).
- Discovery empty-result rate isn't logged yet (add a counter for the launch metrics).
- MSG91 provider is implemented against the documented Flow API but untested without an account.

## 2026-11-17 — tsconfig cleanup

- Removed deprecated `baseUrl` from `tsconfig.json` (TypeScript 6 deprecation warning). No imports relied on it; `tsc --noEmit` is clean.

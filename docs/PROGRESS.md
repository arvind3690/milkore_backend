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
| 2026-11-17 | N1 | Push notifications (ADR-022): FCM provider, device tokens, inbox, preferences, role-specific event pushes, admin campaigns, migration `d5_notifications` | Done (backend) |

## Verified results (latest run)

- `npm test`: 45/45 passed. `npm run test:e2e`: 54/54 passed. `npm run lint`: 0 problems. `tsc --noEmit`: clean (2026-11-17, N1).
- FCM credentials: a dry-run send with the service-account key reached FCM for project `milkore-2345` (rejected only the fake token, as expected).
- Live checks: India Post search (110001) and Nominatim reverse geocoding returned real data; admin dashboard login → stats → vendors through the proxy.

## Not done / founder actions

- AWS (Lightsail, S3, CloudFront), domain, MSG91 + DLT, Play Console, upload keystore — see `LAUNCH_CHECKLIST.md`.
- Sentry not installed yet (decide when deploying).
- `milkore_admin` has no GitHub repository yet (create `arvind3690/milkore_admin`, then push).
- Production push: set `PUSH_PROVIDER=fcm` and provide the key (`FIREBASE_SERVICE_ACCOUNT_BASE64` or a mounted file, see DEPLOYMENT.md). iOS: upload an APNs auth key in Firebase Console → Cloud Messaging.

## Technical debt

- Catalog cache is per-process (10 min); fine for one instance.
- Socket.IO uses the in-memory adapter (single instance) — add the Redis adapter before scaling out (ADR-007).
- Discovery empty-result rate isn't logged yet (add a counter for the launch metrics).
- MSG91 provider is implemented against the documented Flow API but untested without an account.
- Campaigns send in-process (no queue). A restart mid-send leaves partial delivery; stuck campaigns are marked FAILED after 10 minutes on the next start. Use a queue before large audiences.
- `firebase-admin` install scripts for `@firebase/util` and `protobufjs` are denied in `allowScripts` (not needed on Node for FCM).

## 2026-11-17 — tsconfig cleanup

- Removed deprecated `baseUrl` from `tsconfig.json` (TypeScript 6 deprecation warning). No imports relied on it; `tsc --noEmit` is clean.

## 2026-11-17 — N1 push notifications

- New `notifications` module, migration `d5_notifications` (4 tables), env `PUSH_PROVIDER`, `FIREBASE_SERVICE_ACCOUNT_PATH|BASE64`. Details: ADR-022, API_DOCUMENTATION.md "Notifications".
- Pushes: chat message (offline recipient), vendor status, product removed/restored, support reply/status, report closed, admin campaigns.
- Fixes found while testing: `OTP_DEV_STATIC_CODE` now applies only in `NODE_ENV=development` (it leaked into e2e because ConfigModule re-reads .env); e2e runs use a per-run client IP so OTP per-IP limits from earlier runs don't fail the suite; preference booleans reject strings instead of coercing "nope" to true.


## 2026-11-18 - Secrets untracked

- Removed committed secret `.env`, `firebase-service-account.json` from git tracking (kept on disk; already in .gitignore): `.env`, `firebase-service-account.json`. They remain in earlier commits, so rotate those keys.


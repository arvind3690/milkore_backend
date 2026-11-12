# CLAUDE.md — milkore_backend (NestJS API)

Read this file fully before any change in this repo. **This repo also holds the product-wide documents** in `docs/`.

## Product

**Milkore** is a location-based dairy marketplace for India. Customers find nearby milk/dairy vendors, compare products and prices, then chat in-app or call through the native dialer. Vendors register, list products with their own prices, and define where they sell. Admins approve vendors and moderate content through a separate Next.js dashboard.

- Roles: **CUSTOMER**, **VENDOR** (Flutter app, `../milkore_app`) and **ADMIN** (Next.js dashboard, future `../milkore_admin`, separate auth).
- **MVP:** OTP login, location search (India Post PIN API), vendor onboarding + admin approval, products and prices, PostGIS nearby discovery, free chat (REST + Socket.IO), free calls (dialer + call log), reports, support, admin APIs.
- **Not in MVP:** payments, paid chat (₹10) / paid call (₹50), orders, delivery, subscriptions, reviews, **push notifications / Firebase**.
- **Future-ready hooks (build the hook, not the feature):** every chat/call path goes through `CommunicationPolicyService` + `communication_access` (FREE_MVP today, PAID later); outbound notifications go through a `NotificationSender` interface (no-op today).

## Documents (keep them current)

| File | Purpose |
|---|---|
| `docs/PRD.md` | Product requirements |
| `docs/PROJECT_PLAN.md` | Scope, milestones, risks |
| `docs/DEVELOPMENT_ROADMAP.md` | Phases + dependencies |
| `docs/ARCHITECTURE.md` | System and backend architecture (Mermaid) |
| `docs/DATABASE_SCHEMA.md` | Tables, relations, indexes, ownership rules |
| `docs/API_DOCUMENTATION.md` | Every endpoint with request/response/error examples |
| `docs/DECISIONS.md` | ADRs (context → decision → consequences) |
| `docs/PROGRESS.md` | Progress log, updated after every phase |
| `../MILKORE_PHASE_PROMPTS.md` | Phase prompts. Run only the phase you're asked to run |

## Current state (2026-11-13)

- All MVP modules are implemented and tested: 26 unit + 41 e2e tests pass (`npm test`, `node scripts/test-db.cjs && npm run test:e2e`).
- Local DB: PostgreSQL 18 with PostGIS 3.7; migrations `d1`, `d2_d3`, `d4` applied; base + dev seeds available.
- Progress and remaining founder actions: `docs/PROGRESS.md`; deployment: `docs/DEPLOYMENT.md`; launch: `docs/LAUNCH_CHECKLIST.md`.

## Target architecture

**Stack:** Node.js LTS, NestJS (modular monolith), TypeScript strict, PostgreSQL + **PostGIS**, Prisma, Socket.IO (`@nestjs/websockets`), AWS S3 (presigned uploads), class-validator DTOs, nestjs-pino logging, `@nestjs/throttler`, Swagger (non-production), Jest + Supertest.
No microservices, Kubernetes, Redis or queues until a documented need appears.

```
src/
  main.ts                 global prefix /api/v1, helmet, CORS, ValidationPipe, Swagger (non-prod)
  app.module.ts
  config/                 typed config + env validation (fail fast on a missing var)
  common/                 envelope interceptor, exception filter, guards, decorators (@CurrentUser, @Roles, @Public), pagination, utils
  prisma/                 PrismaModule + PrismaService
  modules/
    health/ auth/ users/ locations/ customer/ media/ vendor-onboarding/ vendor-profile/
    catalog/ vendor-products/ discovery/ chat/ communication-policy/ calls/
    reports/ support/ admin/ audit/
prisma/
  schema.prisma  migrations/  seed.ts
test/            e2e tests
```

Each module: `*.module.ts`, `*.controller.ts` (thin), `*.service.ts` (business rules), `dto/`, and optional `*.repository.ts` for complex Prisma/raw SQL. Controllers never call Prisma directly.

## API contract (shared with milkore_app; the Flutter code depends on it)

- Base path **`/api/v1`**. JSON camelCase, ISO-8601 UTC, UUID ids, money as integer **paise** (plus a formatted display string where useful).
- **Every response** goes through one interceptor and one exception filter:
  `{ "statusCode": <int>, "message": "<string>", "data": <payload | null> }`, with the HTTP status equal to `statusCode`.
  - Success uses **200** (or 201 for creates). **Never 204**: return 200 with `data: null`.
  - Validation: `400` plus `"errors": { "<field>": ["message", ...] }` at the top level.
  - Rate limit: `429` plus a `Retry-After` header (seconds).
  - 5xx responses never leak stack traces or SQL.
  - Lists: `data: { items, page, limit, total }`; chat history: `data: { items, nextCursor }`.
- **Auth rules (they must match the app's envelope logic):**
  - Login endpoints live under **`/auth/login/...`**: `POST /auth/login/otp/request`, `POST /auth/login/otp/verify`. Wrong or expired OTP → `400` (never 401).
  - Expired or invalid access token on a protected route → `401` (the app then refreshes once and retries).
  - `POST /auth/refresh` with body `{ "refresh_token": "..." }` → **HTTP 200** (use `@HttpCode(200)`; Nest's POST default of 201 breaks the app's refresh) and `data: { accessToken, refreshToken, expiresIn }`. Rotate on every use; reuse of a rotated token revokes the whole session chain and returns `401`.
  - Suspended user → `403` with a clear message. Ended session that must log out → `401` (no Bearer) or `406`.
  - Access JWT about 15 min, refresh 30 days, hashed in the DB. Admin tokens use a different secret and audience; customer/vendor tokens can never reach `/admin/*`.
- **Headers the app sends** (accept them; never depend on them for security): `Authorization`, `x-client-transport: native`, `InfoJson` (device info JSON). Allow them in CORS for the admin origin as needed.

## Domain rules (non-negotiable)

- **Ownership:** a vendor's id always comes from the JWT, never from the body or the URL. Another vendor's resource returns `404`.
- Public discovery shows only vendors that are `APPROVED`, whose user is `ACTIVE`, and that aren't deleted.
- Discovery runs in PostGIS (`geography(Point,4326)`, GIST index, `ST_DWithin` / `ST_Distance`) with parameterized `$queryRaw`. No distance math in app code, no string-concatenated SQL.
- A vendor matches a customer by **service area**: radius from the business location, **or** a served PIN code, **or** a served locality.
- **PIN data:** India Post API `https://api.postalpincode.in/pincode/{PIN}` and `/postoffice/{name}` (free, no key). The response is an array with `Status`, `Message`, `PostOffice[]`, and **no coordinates**. Call it only from the backend behind a `PincodeProvider` interface, cache it in the DB, use timeout + retry + circuit breaker, and treat `Status: "Error"` as not found. GPS → PIN uses a separate `GeocodingProvider` (chosen in DECISIONS.md).
- OTP: hashed, 5-minute expiry, max 5 attempts, resend cooldown, per-phone and per-IP limits, same response whether or not the phone exists.
- Images: presigned S3 upload, jpeg/png/webp ≤ 5 MB, verify on confirm, strip EXIF.
- Write `audit_logs` for login/logout, account deletion, and every admin action.
- Logs never contain OTPs, tokens, full phone numbers (mask to last 4), passwords, DATABASE_URL, or precise coordinates (round to 2 decimals).

## Database rules

- Prisma migrations only: `prisma migrate dev --create-only` → review SQL → `prisma migrate dev`. Production: `prisma migrate deploy`.
- **Never** run `prisma migrate reset`, `prisma db push`, `DROP`, `TRUNCATE`, or delete data unless the user explicitly asks in that message.
- Tables are snake_case (`@@map`), fields camelCase in Prisma, UUID PKs, `createdAt`/`updatedAt`, soft delete (`deletedAt`) where the schema doc says so.
- PostGIS columns are `Unsupported("geography(Point,4326)")`, with GIST indexes added in the migration SQL.

## Working rules

1. One phase at a time. Explain the plan before coding; ask before any scope or technology change.
2. No new dependency without a one-line justification in the report.
3. Tests come with the code (unit for services, e2e for endpoints incl. authorization). Run `npm run lint`, `npm test`, `npm run test:e2e` and report the real output.
4. Never print secrets or the connection string. `.env` is never committed; keep `.env.example` current.
5. Update `docs/API_DOCUMENTATION.md`, `docs/DATABASE_SCHEMA.md`, `docs/PROGRESS.md` and `docs/DECISIONS.md` every phase that touches them.
6. Never claim something works without running it. Don't overwrite working code without understanding it.
7. Commit only when asked. Git identity for this repo is local (arvind3690); don't change git config.

## End-of-task report format

- Files created
- Files modified
- Features implemented
- Commands and tests run, with the real results
- Known issues and technical debt
- Remaining tasks
- Next recommended task

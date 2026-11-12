# Milkore API

NestJS modular monolith for **Milkore**, a location-based dairy marketplace (India). PostgreSQL + PostGIS, Prisma, Socket.IO.

- Mobile app: [`milkore_app`](https://github.com/arvind3690/milkore_app) · Admin dashboard: `milkore_admin`
- Product & architecture docs: [`docs/`](docs) — start with `PRD.md`, `ARCHITECTURE.md`, `API_DOCUMENTATION.md`, `DATABASE_SCHEMA.md`, `DECISIONS.md`
- Rules for contributors (and Claude Code): [`CLAUDE.md`](CLAUDE.md)

## Quick start (local)

Requirements: Node 22+, PostgreSQL 15+ **with PostGIS** (Windows: Stack Builder → Spatial Extensions → PostGIS bundle).

```bash
cp .env.example .env            # set DATABASE_URL and generate the secrets
npm install
npx prisma migrate deploy       # or: npx prisma migrate dev (development)
npm run db:seed                 # categories, units, first super admin
npm run seed:dev                # optional: 15 demo vendors around DEV_SEED_LAT/LNG
npm run start:dev               # http://localhost:3000/api/v1  · Swagger: /api/docs
```

In development `SMS_PROVIDER=console` prints the OTP in the API log, and `STORAGE_PROVIDER=local` stores photos in `./uploads`.

## Tests

```bash
npm test                        # unit tests
node scripts/test-db.cjs        # creates/migrates <db>_test (never touches your dev DB)
npm run test:e2e                # 41 end-to-end tests: auth, onboarding, admin, discovery, chat (Socket.IO), trust
npm run lint
```

## Modules

`auth` (OTP + rotating refresh tokens) · `locations` (India Post PIN proxy + cache, Nominatim reverse geocoding) · `media` (presigned uploads, EXIF stripping) · `vendors` (onboarding, profile, catalogue, products) · `discovery` (PostGIS service-area matching) · `chat` (REST + Socket.IO, calls, communication policy) · `trust` (reports, support) · `admin` (separate admin auth, approvals, moderation, audit) · `health`.

## Deploy

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) (Docker Compose on Lightsail, Caddy TLS, nightly backups) and [`docs/LAUNCH_CHECKLIST.md`](docs/LAUNCH_CHECKLIST.md).

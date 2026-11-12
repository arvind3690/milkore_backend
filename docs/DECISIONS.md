# Milkore — Architecture Decision Records

Format: Context → Decision → Consequences. Status: Proposed | Accepted | Superseded.

## ADR-001 Separate repos per component — Accepted (P0.1)
- Context: the founder created separate GitHub repos (milkore_app, milkore_backend).
- Decision: one repo per component; the admin dashboard gets its own repo in W1. Product-wide docs live in milkore_backend/docs.
- Consequences: the API contract is duplicated in both CLAUDE.md files and must change in both together.

## ADR-002 No Firebase / push notifications in the MVP — Accepted (P0.1)
- Decision: remove Firebase from the app (F1). Unread state is fetched on app open/resume and live over Socket.IO while the app is open. The backend keeps a no-op NotificationSender.
- Consequences: users don't get alerts while the app is closed. Push can be added later without changing the chat module.

## ADR-003 India Post PIN API for PIN/locality data — Accepted (P0.1)
- Decision: https://api.postalpincode.in, called only from the backend behind PincodeProvider, cached in the DB.
- Consequences: no coordinates, so GPS → PIN needs a separate GeocodingProvider (to decide in P0.2); availability risk is reduced by the cache and circuit breaker.

## ADR-004 Keep the existing Flutter architecture and API envelope — Accepted (P0.1)
- Decision: keep Riverpod codegen + go_router + ApiClient/Result + StatusCodeMessageDataEnvelope. The backend returns `{statusCode, message, data}`.
- Consequences: login routes stay under /auth/login/*, refresh returns HTTP 200, no 204 responses.

## Resolved in P0.2 (see ADR-005 … ADR-016)


## ADR-005 NestJS instead of the plain Express setup — Accepted (P0.2)
- Context: the repo had express/pg dependencies but no code.
- Decision: NestJS modular monolith (DI, guards, pipes, gateways and testing are built in).
- Consequences: more structure from day one; express/pg/bcrypt/cors/dotenv packages replaced by Nest equivalents.

## ADR-006 Socket.IO for real-time chat — Accepted (P0.2)
- Decision: `@nestjs/websockets` + Socket.IO namespace `/chat`; REST is the only write path; the socket only pushes events.
- Why: reconnection, rooms and fallbacks out of the box; a mature Dart client (socket_io_client).
- Consequences: sticky sessions + Redis adapter are needed when we scale beyond one instance (ADR-007).

## ADR-007 Single instance until needed — Accepted (P0.2)
No Redis, queues or microservices. Add the Socket.IO Redis adapter when we run 2+ API instances.

## ADR-008 Guest browsing — Accepted (P0.2, founder default)
Customers can browse vendors without logging in. Chat, call, report and vendor onboarding require OTP login.

## ADR-009 Vendor phone visibility — Accepted (P0.2, founder default)
The phone number is never in public discovery responses. It's returned only by `POST /calls` to a logged-in customer, through CommunicationPolicy, and every reveal is logged. This is also the hook for paid calls.

## ADR-010 SMS provider — Accepted (P0.2, founder default)
MSG91 (India, DLT-compliant, ≈ ₹0.2/SMS) behind `SmsProvider`. Development uses `ConsoleSmsProvider`. Production needs DLT registration + template id (founder action).

## ADR-011 Reverse geocoding — Accepted (P0.2, founder default)
OpenStreetMap Nominatim behind `GeocodingProvider` (free; policy: ≤ 1 req/s, identifying User-Agent, results cached). Switch to Ola Maps / Mappls if volume grows.

## ADR-012 No map SDK in the MVP — Accepted (P0.2)
Vendor location = GPS capture + address confirmation. Customers see an "Open in Maps" link. Avoids API keys and app size.

## ADR-013 Hosting — Accepted (P0.2)
Lightsail instance with Docker Compose (Caddy, API, `postgis/postgis`), nightly `pg_dump` to S3. PostGIS on Lightsail managed databases isn't documented, so we avoid it. Move to RDS at growth.

## ADR-014 Android applicationId — Accepted (P0.2, founder default)
`com.milkore.app` (set in F1, before any store upload; it can't change after publishing).

## ADR-015 Discovery defaults — Accepted (P0.2)
Default vendor service radius 3 km (choices 1–10 km, max 20 km). Customer search shows vendors whose service area covers the customer, sorted by distance. Languages at launch: English + Hindi.

## ADR-016 Money as integer paise — Accepted (P0.2)
Prices are stored and transferred as integers in paise; display strings are formatted on the server and in the app.

## ADR-017 bcryptjs instead of native bcrypt — Accepted (A7)
Native `bcrypt` needs C++ build tools on Windows and in slim images. `bcryptjs` (pure JS, cost 12) is fast enough for admin logins only (app users have no passwords).

## ADR-018 Isolated e2e database — Accepted (Q1)
`scripts/test-db.cjs` creates `<db>_test` on the same server, applies migrations and the base seed. E2E tests never touch development data; CI uses a PostGIS service container.

## ADR-019 Phone numbers in tombstones on account deletion — Accepted (A1)
Deleted users keep their row (chat history integrity) with `phone = del_<id-prefix>`, `name = null`, status DELETED, sessions revoked, vendor listing hidden. The same number can sign up again as a new user.

## ADR-020 Relative media URLs in development — Accepted (A3)
Local storage returns `/api/v1/media/files/...`; clients resolve against their API origin, so emulator (10.0.2.2), phone (LAN IP) and admin all work. Production URLs are absolute (CloudFront).

## ADR-021 Admin tokens only in httpOnly cookies — Accepted (W1)
The dashboard's route handlers log in, keep access/refresh tokens in `httpOnly; SameSite=Strict` cookies and proxy `/admin/*` server-side. Browser JavaScript never sees a token.

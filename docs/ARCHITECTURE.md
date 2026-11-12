# Milkore — System Architecture

## 1. Components
```mermaid
flowchart LR
  subgraph Clients
    APP[Flutter app<br/>Customer + Vendor]
    ADM[Next.js admin]
  end
  subgraph Server["Lightsail instance (Docker)"]
    PX[Caddy / Nginx<br/>TLS + WebSocket upgrade]
    API[NestJS modular monolith<br/>REST /api/v1 + Socket.IO /chat]
    DB[(PostgreSQL + PostGIS)]
  end
  S3[(S3 private bucket)]
  CF[CloudFront]
  IP[India Post PIN API]
  NOM[Nominatim reverse geocoder]
  SMS[SMS provider<br/>MSG91]
  APP -- HTTPS / WSS --> PX
  ADM -- HTTPS --> PX
  PX --> API
  API --> DB
  API -- presigned URLs --> S3
  APP -- PUT image --> S3
  APP -- GET image --> CF --> S3
  API --> IP
  API --> NOM
  API --> SMS
```

## 2. Backend modules (NestJS)
```mermaid
flowchart TB
  common[common: envelope, filters, guards, decorators]
  prisma[PrismaModule]
  auth[auth] --> users[users]
  auth --> sms[SmsProvider]
  locations[locations] --> pin[PincodeProvider: India Post] & geo[GeocodingProvider: Nominatim]
  customer[customer] --> locations
  media[media] --> storage[StorageProvider: S3 / local]
  onboarding[vendor-onboarding] --> media & locations
  vprofile[vendor-profile]
  catalog[catalog]
  vproducts[vendor-products] --> catalog & media
  discovery[discovery]
  policy[communication-policy]
  chat[chat REST + gateway] --> policy & notif[NotificationSender no-op]
  calls[calls] --> policy
  reports[reports]
  support[support]
  admin[admin + admin-auth] --> audit[audit]
```
Rules: controllers are thin; services hold business rules; ownership comes from the JWT; raw SQL only in repository classes, always parameterised.

## 3. Authentication flow
```mermaid
sequenceDiagram
  participant A as App
  participant API
  participant SMS
  A->>API: POST /auth/login/otp/request {phone}
  API->>API: rate-limit (phone, IP), create OTP (HMAC hash, 5 min)
  API->>SMS: send OTP (console in dev)
  API-->>A: 200 {resendAfterSeconds}
  A->>API: POST /auth/login/otp/verify {phone, otp, deviceId}
  API->>API: check hash, attempts ≤ 5, upsert user
  API-->>A: 200 {accessToken 15m, refreshToken 30d, user, isNewUser}
  A->>API: GET /discovery/... (Bearer)
  API-->>A: 401 (expired)
  A->>API: POST /auth/refresh {refresh_token}
  API->>API: rotate (revoke old, issue new; reuse → revoke chain)
  API-->>A: 200 {accessToken, refreshToken}
```

## 4. Location and discovery
```mermaid
flowchart TB
  G[GPS lat/lng] --> R[/GET locations/reverse/] --> NOM[Nominatim → PIN] --> IP[India Post: district/state]
  M[Manual search q] --> S[/GET locations/search/] --> C{cache hit?}
  C -- yes --> RES[results]
  C -- no --> IP2[India Post API] --> CACHE[(post_offices, pincode_lookups)] --> RES
  RES --> SEL[Selected location: lat/lng? + pincode + label]
  SEL --> D[/GET discovery/vendors/]
  D --> Q["PostGIS query:<br/>APPROVED + ACTIVE + not deleted AND<br/>(ST_DWithin(location, point, radius)<br/> OR pincode ∈ served PINs<br/> OR locality ∈ served localities)<br/>ORDER BY ST_Distance"]
```

## 5. Chat and calls
```mermaid
sequenceDiagram
  participant C as Customer app
  participant API
  participant V as Vendor app
  C->>API: POST /conversations {vendorId}
  API->>API: CommunicationPolicy.canAccess(CHAT) → FREE_MVP
  C->>API: POST /conversations/:id/messages {clientMessageId, body}
  API->>API: store (idempotent), bump unread
  API-->>V: socket "message:new" (if connected)
  API->>API: NotificationSender.notify() (no-op in MVP)
  V->>API: GET /me/unread-summary (on open/resume)
  C->>API: POST /calls {vendorId}
  API->>API: policy(CALL) + call_logs
  API-->>C: {phone} → native dialer
```
Socket.IO runs in the same process. When there is more than one instance, add the Redis adapter (ADR-007).

## 6. File storage
Client asks `POST /media/upload-url` → receives a presigned PUT (5 min) → uploads directly to S3 → `POST /media/:id/confirm` → the API checks size and type, strips EXIF (sharp) and marks the asset READY. Reads go through CloudFront (or presigned GET in dev). In development without AWS keys, a `LocalStorageProvider` writes to `uploads/` and serves `/media/files/*`.

## 7. Deployment
```mermaid
flowchart LR
  GH[GitHub] -- Actions: lint, test, build --> IMG[Docker image]
  IMG --> LS[Lightsail instance<br/>docker compose: caddy, api, postgis]
  LS -- nightly pg_dump --> S3B[(S3 backups, 14 days)]
  LS --> SEN[Sentry] & UP[Uptime monitor]
```
Migrations run with `prisma migrate deploy` during deploy. Rollback = previous image tag + restore point.

## 8. Admin dashboard (Next.js)
App Router; route handlers proxy to the API and keep admin tokens in httpOnly cookies; `middleware.ts` protects all routes except `/login`; TanStack Query for data; shadcn/ui components.

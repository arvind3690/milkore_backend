# Milkore API — Reference

Base URL: `https://api.milkore.in/api/v1` (dev: `http://localhost:3000/api/v1`, Android emulator: `http://10.0.2.2:3000/api/v1`).
Interactive docs (non-production): `GET /api/docs` (Swagger).

## Conventions

Every response — success **and** error — uses one envelope:

```json
{ "statusCode": 200, "message": "Success", "data": { } }
```

| Situation | HTTP | Body |
|---|---|---|
| Success | 200 (201 for creates) | `data` = payload. Never 204: empty → `data: null` |
| Validation | 400 | `message` + `errors: { "field": ["problem"] }` |
| Not logged in / token expired | 401 | app refreshes once, then logs out |
| Suspended / not allowed | 403 | friendly `message` |
| Not found **or not yours** | 404 | ownership failures are 404, never 403 |
| Conflict (state machine, duplicates) | 409 | |
| Rate limited | 429 | `Retry-After` header (seconds) |
| Server error | 500 | generic message, no internals |

- JSON camelCase, ISO-8601 UTC timestamps, UUID ids, money in **integer paise** plus display strings (`priceDisplay`, `priceDisplayHi`).
- Lists: `data: { items, page, limit, total }` (`?page=1&limit=20`, max 50). Chat history: `data: { items, nextCursor }`.
- Auth: `Authorization: Bearer <accessToken>` (15 min). Public routes accept a token but don't require one.
- Media URLs may be relative in development (`/api/v1/media/files/...`); resolve them against the API origin.

## Auth (app users)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth/login/otp/request` | public, 5/min | `{ phone, purpose?: "LOGIN" }` → `{ resendAfterSeconds: 30, expiresInSeconds: 300 }`. 30 s resend cooldown, 5/hour per phone, 20/hour per IP → 429 |
| POST | `/auth/login/otp/verify` | public | `{ phone, otp, deviceId? }` → tokens + user. Wrong/expired OTP → **400** (never 401) |
| POST | `/auth/refresh` | public | `{ "refresh_token": "…" }` → **HTTP 200** `{ accessToken, refreshToken, expiresIn }`. Rotates; reuse of an old token revokes the whole session family (401) |
| POST | `/auth/logout` | user | `{ refresh_token? }` revokes that session family (or all sessions) |
| GET | `/me` | user | current user |
| PATCH | `/me` | user | `{ name?, preferredLanguage?: "en"\|"hi" }` |
| DELETE | `/me` | user | account deletion: anonymises phone/name, hides vendor listing, revokes sessions |

```json
// POST /auth/login/otp/verify → 200
{
  "statusCode": 200, "message": "Logged in",
  "data": {
    "accessToken": "eyJ…", "refreshToken": "q3…", "expiresIn": 900, "isNewUser": true,
    "user": { "id": "95bb…", "phone": "+919876543210", "name": null, "role": "CUSTOMER",
              "status": "ACTIVE", "preferredLanguage": "en", "vendorStatus": null, "createdAt": "…" }
  }
}
// 400
{ "statusCode": 400, "message": "Wrong OTP. 4 attempts left.", "data": null }
```

Phones are accepted as `9876543210`, `+91 98765-43210`, `09876543210`; stored as E.164.

## Locations (India Post + Nominatim, backend-proxied and cached)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/locations/search?q=` | public, 30/min | 6 digits → PIN lookup; else post office / area name (≥3 letters). → `[{ name, pincode, district, state, label }]` |
| GET | `/locations/pincode/:pin` | public | `{ pincode, district, state, postOffices: [{ name, branchType, deliveryStatus }] }` (vendor address autofill) |
| GET | `/locations/reverse?lat=&lng=` | public, 20/min | GPS → `{ lat, lng, label, locality, city, district, state, pincode }`. Outside India → 400 |
| GET | `/customer/location` | user | saved browsing location or `null` |
| PUT | `/customer/location` | user | `{ label, pincode, lat?, lng?, city? }` (manual PIN choice may omit coordinates) |

If India Post is down: cached results, else 503 "PIN code search is temporarily unavailable. Please use your current location."

## Media (photos)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/media/upload-url` | user | `{ purpose: VENDOR_PROFILE\|VENDOR_SHOP\|PRODUCT, mimeType: image/jpeg\|png\|webp, sizeBytes ≤ 5 MB }` → `{ mediaId, uploadUrl, method: "PUT", headers, expiresInSeconds: 300 }` |
| PUT | `uploadUrl` | — | raw image bytes (S3 presigned in prod; `/media/local-upload/:id?exp&sig` in dev) |
| POST | `/media/:id/confirm` | owner | validates it is a real image, auto-rotates, resizes ≤1280 px, re-encodes (strips EXIF/GPS) → `{ id, status: "READY", width, height, url }` |
| GET | `/media/files/*` | public | dev storage only |

## Vendor onboarding & profile (role VENDOR; `start` works for any logged-in user)

| Method | Path | Notes |
|---|---|---|
| POST | `/vendor/onboarding/start` | creates DRAFT shop, upgrades role → `{ accessToken, refreshToken, expiresIn, vendor }` |
| GET | `/vendor/onboarding` (= `/vendor/profile`) | owner view incl. `completion: { steps, missing, percent }` |
| PATCH | `/vendor/onboarding/business` | `{ ownerName?, businessName?, description?, operatingHours? }` — hours: all 7 days `mon..sun → { open "HH:mm", close "HH:mm", closed }` |
| PATCH | `/vendor/onboarding/photos` | `{ profilePhotoId, shopPhotoId? }` (READY assets you own, right purpose) |
| PATCH | `/vendor/onboarding/location` | `{ addressLine, locality, city, district, state, pincode, lat, lng }` |
| PUT | `/vendor/onboarding/service-areas` | `{ radiusMeters? (500–20000), pincodes?: [], localities?: [] }` — at least one |
| POST | `/vendor/onboarding/submit` | DRAFT/REJECTED → PENDING; 400 with `errors.missing` if incomplete |
| PATCH | `/vendor/availability` | `{ isAvailable }` ("I'm selling today") |

Editing the **business name, profile photo or location** of an APPROVED shop moves it back to PENDING (re-review). Hours, description, service areas and availability never do. SUSPENDED shops cannot edit (409).

## Catalogue & vendor products

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/catalog/categories` | public | `[{ id, slug, nameEn, nameHi, iconKey, sortOrder }]` (cached 10 min) |
| GET | `/catalog/units` | public | `[{ id, code, labelEn, labelHi }]` |
| GET | `/vendor/products` | vendor | own products |
| POST | `/vendor/products` | vendor | `{ categoryId, unitId, name, pricePaise (100–10,000,000), description?, imageId?, isAvailable? }` → 201; max 50 |
| PATCH | `/vendor/products/:id` | vendor | partial update |
| PATCH | `/vendor/products/:id/price` | vendor | `{ pricePaise }` (writes price history) |
| PATCH | `/vendor/products/:id/availability` | vendor | `{ isAvailable }` |
| DELETE | `/vendor/products/:id` | vendor | soft delete |

Another vendor's product id → 404. Products removed by an admin can't be edited (409).

## Discovery (public)

| Method | Path | Notes |
|---|---|---|
| GET | `/discovery/vendors?lat=&lng=&pincode=&locality=&categoryId=&q=&availableOnly=&page=&limit=` | vendors whose service area covers the customer, sorted by distance; each with up to 3 products. Empty → `nearestServingDistanceKm` |
| GET | `/discovery/products?…same…` | products of serving vendors, with `vendor: { id, businessName, isAvailable, distanceMeters }` |
| GET | `/vendors/:id?lat=&lng=` | public vendor profile: photos, address + map point, service areas, hours, products, `distanceMeters`, `canChat`, `canCall`. **No phone number** |

Matching rule (PostGIS): APPROVED ∧ user ACTIVE ∧ not deleted ∧ (inside any RADIUS rule from the shop ∨ customer PIN ∈ served PINs ∨ customer locality ∈ served localities). Needs `lat+lng` or `pincode`.

## Chat & calls (logged in)

| Method | Path | Notes |
|---|---|---|
| POST | `/conversations` | `{ vendorId }` → conversation (get or create). Own shop → 400 |
| GET | `/conversations?page=` | both roles; `myRole`, `counterpart { name, photoUrl, vendorId? }`, `unreadCount` |
| GET | `/conversations/:id` | participants only (else 404) |
| GET | `/conversations/:id/messages?before=&limit=` | newest first, `nextCursor` |
| POST | `/conversations/:id/messages` | `{ clientMessageId, body ≤ 2000 }` — idempotent per `clientMessageId`; 30/min |
| POST | `/conversations/:id/read` | marks the other side's messages read |
| POST | `/conversations/:id/block` · `/unblock` | |
| GET | `/me/unread-summary` | `{ unreadConversations, unreadMessages, vendorStatus, vendorRejectionReason }` (no push in MVP: call on open/resume) |
| POST | `/calls` | `{ vendorId }` → `{ vendorId, businessName, phone }`; logs the reveal |

Every chat start/send and call passes `CommunicationPolicyService` (free today; the paid-access hook).

**Socket.IO** namespace `/chat`, `auth: { token }`. Server events: `ready`, `auth_error`, `message:new { conversationId, message }`, `message:read { conversationId, readerUserId, readAt }`, `typing { conversationId, userId }`. Client event: `typing { conversationId }`.

## Reports & support (logged in)

| Method | Path | Notes |
|---|---|---|
| POST | `/reports` | `{ targetType: VENDOR\|PRODUCT\|USER\|MESSAGE, targetId, reason: FAKE_VENDOR\|WRONG_PRICE\|BAD_QUALITY\|ABUSIVE\|SPAM\|OTHER, details? }` — 10/day; duplicate open reports return the existing one |
| POST | `/support/tickets` | `{ subject, message }` — max 5 open |
| GET | `/support/tickets` | own tickets with `adminNote` replies |

## Admin (separate tokens: different secret and audience; app tokens get 401 here)

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/admin/auth/login` | public | `{ email, password, totp? }` → tokens + admin. 5 failures → 15-min lock |
| POST | `/admin/auth/refresh` · `/logout` · GET `/me` | | refresh rotates (7-day family) |
| GET | `/admin/stats` | any | counts + `signupsByDay` (30 days) |
| GET | `/admin/vendors?status=&search=` · `/admin/vendors/:id` | any | detail incl. history, products, counts |
| POST | `/admin/vendors/:id/approve` · `reject {reason}` · `suspend {reason}` · `reactivate` | any | state machine enforced (409 otherwise); audit logged |
| GET | `/admin/users?role=&status=&search=` · `/admin/customers` | any | |
| PATCH | `/admin/users/:id/status` | any | `{ status: ACTIVE\|SUSPENDED, reason? }` (suspend revokes sessions) |
| GET | `/admin/categories` | any | |
| POST / PATCH | `/admin/categories[/:id]` | SUPER_ADMIN | |
| GET | `/admin/products?search=&vendorId=&status=` | any | |
| POST | `/admin/products/:id/remove {reason}` · `/restore` | any | |
| GET / PATCH | `/admin/reports[/:id]` | any | `{ status: OPEN\|RESOLVED\|DISMISSED, note? }` |
| GET / PATCH | `/admin/support-tickets[/:id]` | any | `{ status?, adminNote? }` |
| GET | `/admin/audit-logs?entityType=&entityId=&actorId=` | any | |
| GET / POST | `/admin/admins` · PATCH `/admin/admins/:id/status` | SUPER_ADMIN | |

## Health

`GET /health` → `{ status, db: up|down, postgis: installed|available|missing, version }`.

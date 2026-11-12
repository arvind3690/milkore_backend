# Milkore — Play Store Readiness & Pilot Launch (Q4 + L1)

## Founder actions (cannot be done from code)

- [ ] **Google Play Console** account ($25 one-time).
- [ ] **Upload keystore** — create and keep it safe (password manager + offline copy):
  ```bash
  keytool -genkey -v -keystore milkore-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias milkore
  ```
  Create `milkore_app/android/key.properties` (git-ignored):
  ```
  storePassword=…
  keyPassword=…
  keyAlias=milkore
  storeFile=C:/secure/milkore-upload.jks
  ```
  Then wire `signingConfigs.release` in `android/app/build.gradle.kts` (currently the release build uses debug keys — **must change before upload**). Enrol in Play App Signing.
- [ ] **SMS**: MSG91 account + DLT entity/sender/template registration (template with `{#var#}` for the OTP) → `SMS_PROVIDER=msg91`, `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID`.
- [ ] **AWS**: follow `DEPLOYMENT.md` §1–3.
- [ ] **Domain** `milkore.in`: API, admin, privacy policy and terms pages (`https://milkore.in/privacy`, `/terms` are linked in the app).
- [ ] **Play reviewer login**: set `OTP_TEST_ENABLED=true`, `OTP_TEST_PHONES=+91XXXXXXXXXX`, `OTP_TEST_CODE=xxxxxx` and give these in Play Console → App access. Disable after review if you prefer.

## Release build

```bash
cd milkore_app
flutter build appbundle --release \
  --dart-define=APP_ENV=production \
  --dart-define=API_BASE_URL=https://api.milkore.in/api/v1 \
  --obfuscate --split-debug-info=build/symbols
```
Keep `build/symbols` for crash de-obfuscation. Version is `pubspec.yaml` `version: 1.0.0+1` (bump the `+N` every upload).

## Store listing (draft)

- **Name**: Milkore – Fresh Milk Near You
- **Short (EN)**: Find local milk & dairy sellers near you. Compare prices, chat or call.
- **Short (HI)**: पास के दूध वाले खोजें। दाम देखें, चैट या कॉल करें।
- **Full description**: who it's for (households + local dairy sellers), free, Hindi + English, no payments in the app.
- **Category**: Food & Drink. **Content rating**: Everyone. **Ads**: No.
- **Screenshots** (phone): Home with nearby sellers · Vendor details with prices · Chat · Become a seller · My shop dashboard (EN and HI sets).

## Data safety form (matches what the app actually does)

| Data | Collected | Shared | Purpose | Optional |
|---|---|---|---|---|
| Phone number | Yes | With the seller **only when the customer taps Call** (seller's number is shown to the customer) | Account, login | No |
| Name | Yes | Shown to sellers in chat | Account | No |
| Approximate/precise location | Yes | No (never shown to sellers) | App functionality (nearby sellers) | Yes (manual PIN) |
| Photos (vendors) | Yes | Public on the vendor's listing | App functionality | Shop photo optional |
| Messages | Yes | With the chat participant | App functionality | Yes |
| Crash logs / diagnostics | Not yet (add when Sentry is enabled) | | | |

Data is encrypted in transit (HTTPS). Users can delete their account in-app (Profile → Delete my account); deletion URL for the form: `https://milkore.in/delete-account` (page to create, explaining the in-app path).

## Permissions audit (AndroidManifest)

`INTERNET`, `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` only. Camera/gallery go through the system picker (no storage permission). No background location. Cleartext HTTP is allowed in **debug builds only**.

## Pilot go-live (L1)

1. Production deploy per `DEPLOYMENT.md`; `/health` shows `postgis: installed`.
2. `docker compose run --rm api node dist-seed/seed.js` (categories, units, first admin) — **not** `seed:dev`.
3. Warm the PIN cache for pilot PINs: set `PILOT_PINCODES` and call `GET /locations/search?q=<pin>` for each (or a small script).
4. Create moderator accounts in the dashboard (Admins).
5. **Assisted onboarding playbook** — founder registers the first 20–50 vendors in person:
   install app → "Become a seller" on *their* phone → photo of owner and shop → stand at the shop for GPS → radius 2–3 km + nearby PINs → hours → at least 2 products with today's prices → submit → approve from the dashboard on the spot.
6. Smoke test on production with a real phone: OTP login, search near a pilot shop, open details, call, chat both ways, report, delete a test account.
7. Rollback plan: previous image tag + pre-deploy DB dump (see `DEPLOYMENT.md` §4–5).

## First-week metrics (dashboard + SQL)

Signups/day (dashboard chart) · pending approvals age · empty-discovery rate (searches returning 0 — add logging if needed) · chats started · call reveals (`call_logs`) · crash-free sessions (Play Console vitals) · open reports/tickets.

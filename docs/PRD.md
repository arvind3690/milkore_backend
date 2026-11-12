# Milkore — Product Requirements Document

## 1. Vision
Make it effortless for any household in India to find a trusted local milk and dairy seller nearby, and give small dairy sellers a free digital storefront.

## 2. Business objectives (first 6 months)
| Objective | Measure |
|---|---|
| Supply in the pilot city | 100+ approved vendors, ≥ 80% of pilot PIN codes served |
| Customer discovery works | < 15% of discovery searches return zero vendors |
| Connections happen | ≥ 30% of vendor-detail views lead to a chat or call |
| Platform is trusted | < 2% of vendors reported; approvals handled within 24 h |
| Monetisation readiness | Paid chat/call can be enabled by configuration, without a rewrite |

The marketplace connects customers and vendors only. Milkore doesn't sell, deliver or take payments in the MVP.

## 3. Personas
| Persona | Needs | Design implication |
|---|---|---|
| **Neha, 32, urban customer** | Compare prices, find who delivers to her society | Fast list, prices on cards, filters |
| **Ramesh ji, 64, elderly customer** | Big text, Hindi, call the doodhwala | Large touch targets, Hindi, call button always visible |
| **Suresh, 40, milk seller** (basic Android, limited literacy) | Simple sign-up, set today's price, take calls | Step-by-step forms, ≤ 4 fields per screen, icons with labels, voice-friendly words |
| **Admin (founder / ops)** | Approve vendors fast, remove bad content | Pending queue first, one-click actions with reasons |

## 4. Functional requirements

### 4.1 Customer
- C1 Splash with Milkore branding → language choice (English / हिंदी) on first run.
- C2 Location: GPS (optional) or manual PIN / area search (India Post data); saved; changeable at any time.
- C3 Home: location bar, search, category chips, "Become a Vendor", nearby vendors (photo, name, distance, locality, prices, availability).
- C4 Discovery uses the vendor's **service area** (radius, PIN codes, localities), approval status and availability, computed in PostGIS.
- C5 Search and filter by name, category, "available now"; useful empty states (nearest vendor distance).
- C6 Vendor details: photos, address, map link, distance, service areas, products (description, price, unit, availability), timings.
- C7 Chat: text messages with timestamps and history, read status, report/block.
- C8 Call: shows the number and opens the native dialer; logs the call intent.
- C9 Browsing works without login (guest); chat, call, report and vendor registration require OTP login.
- C10 Profile: name, language, location, support tickets, privacy/terms, logout, delete account.

### 4.2 Vendor
- V1 "Become a Vendor" → OTP → 6-step onboarding (business, photos, address via PIN, GPS location, service area, timings) → submit.
- V2 Status screen: Draft / Pending / Approved / Rejected (with reason, edit & resubmit) / Suspended.
- V3 Dashboard: completion %, approval status, "selling today" toggle, products, prices, service areas, profile, chats.
- V4 Products: add/edit/delete; category, name, description, image, price (₹), unit, availability. Only the owner can change them.
- V5 Service areas: radius and/or PIN codes and/or localities, editable.

### 4.3 Admin (web)
- AD1 Secure login (email + password, optional TOTP), roles SUPER_ADMIN and MODERATOR.
- AD2 Stats; customers; vendors with approve / reject / suspend / reactivate.
- AD3 Category management; product moderation (remove with reason).
- AD4 Reports queue; support tickets; audit log.

## 5. Non-functional requirements
| Area | Requirement |
|---|---|
| Performance | Discovery p95 < 300 ms server-side at pilot scale; app cold start < 3 s on a 2 GB device |
| Low bandwidth | Thumbnails ≤ 60 KB, cached responses, works on 3G; no autoplay media |
| Security | OTP rate limits, hashed OTPs and refresh tokens, RBAC, ownership checks, presigned uploads, audit log |
| Privacy | Precise customer location never shown to vendors; phone visible only to logged-in users; EXIF stripped; account deletion |
| Accessibility | Body ≥ 16 sp, targets ≥ 48 dp, 1.5× text scale, TalkBack labels, high contrast (WCAG AA) |
| Language | English + Hindi everywhere at launch |
| Reliability | Daily DB backups (14 days), health checks, error tracking |
| Platforms | Android first (Android 8+); iOS-ready code |
| Maintainability | Modular monolith, documented API contract, tests for every module |

## 6. MVP scope
Everything in section 4. Chat and call are free.

## 7. Out of scope for the MVP
Payments and paid chat/call · orders · delivery · subscriptions · reviews and ratings · push notifications (Firebase) · Milkore own-brand products · multi-city operations tooling · iOS release · public website.

## 8. Future roadmap
1. Push notifications. 2. Reviews and ratings. 3. Paid chat (₹10) / call (₹50) access via Razorpay, using the existing `communication_access` hook. 4. Featured listings and vendor subscriptions. 5. Orders and daily milk subscriptions. 6. Delivery management. 7. Own-brand and partner brand products. 8. Multi-city expansion and iOS.

## 9. Gaps and conflicts found while planning
| Issue | Resolution |
|---|---|
| "Rating if genuine reviews": there are no reviews in the MVP | Hide ratings in the MVP; add them with the reviews feature |
| Showing the vendor phone vs privacy | Show it only to logged-in users; every reveal is logged (also prepares paid calls) |
| Customer location precision | Vendors see only the customer's name in chat, never their coordinates |
| India Post API has no coordinates | GPS → PIN via a reverse geocoder (Nominatim); manual PIN selection matches vendors by served PIN codes |
| Vendor photos of people | Photos are reviewed during admin approval |
| Play Store requires account deletion | `DELETE /me` + an in-app button |

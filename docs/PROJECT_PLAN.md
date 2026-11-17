# Milkore — Project Plan

## Components and repos
| Component | Repo | Stack |
|---|---|---|
| Mobile app (customer + vendor) | milkore_app | Flutter, Riverpod 3, go_router, Dio |
| API | milkore_backend | NestJS, Prisma, PostgreSQL + PostGIS, Socket.IO |
| Admin dashboard | milkore_admin | Next.js (App Router), TypeScript, Tailwind |

## Milestones
| # | Milestone | Phases | Effort (solo + AI) |
|---|---|---|---|
| M1 | Foundation + schema | P0, B1, D1–D5 | 1 week |
| M2 | Core APIs | A1–A7 | 2 weeks |
| M3 | App rebrand + design system | F1–F2 | 1 week (parallel with M1–M2) |
| M4 | App features | F3–F10 | 3 weeks |
| M5 | Admin dashboard | W1–W3 | 1 week |
| M6 | Hardening + deploy | Q1–Q3 | 1–2 weeks |
| M7 | Play Store + pilot | Q4, L1 | 1–2 weeks (incl. review time) |
| | **Total** | | **≈ 10–12 weeks** to pilot |

## Infrastructure cost estimate (INR / month, approximate, Nov 2026)
Prices change; confirm before purchase. USD → INR at about ₹85.

| Item | Minimum launch | Recommended MVP | Growth (≈ 50k users) |
|---|---|---|---|
| Compute (API + Socket.IO) | Lightsail 2 GB ≈ ₹1,000 | Lightsail 4 GB ≈ ₹2,000 | 2× 8 GB + load balancer ≈ ₹9,000 |
| PostgreSQL + PostGIS | Docker on the same instance ₹0 | Separate Lightsail 2 GB instance with Docker PostGIS ≈ ₹1,000 | RDS db.t4g.medium Multi-AZ ≈ ₹10,000 |
| S3 storage (10–100 GB) | ≈ ₹50 | ≈ ₹200 | ≈ ₹2,000 |
| CloudFront image delivery | free tier ₹0 | ≈ ₹300 | ≈ ₹3,000 |
| Admin hosting | same instance ₹0 | Vercel Hobby ₹0 / same instance | Vercel Pro ≈ ₹1,700 |
| Domain (.in / .com) | ≈ ₹80 (₹900/yr) | ≈ ₹80 | ≈ ₹80 |
| SMS OTP (₹0.15–0.25 per SMS; DLT registration ≈ ₹5,900 one-time) | 2k OTP ≈ ₹400 | 10k OTP ≈ ₹2,000 | 100k OTP ≈ ₹20,000 |
| Push | FCM (ADR-022) ₹0 | ₹0 | FCM free |
| Chat | Socket.IO on the API ₹0 | ₹0 | + Redis adapter ≈ ₹1,500 |
| Backups (pg_dump → S3) | ≈ ₹50 | ≈ ₹100 | RDS snapshots ≈ ₹1,000 |
| Monitoring (Sentry free, UptimeRobot free) | ₹0 | ₹0 | Sentry Team ≈ ₹2,200 |
| **Total** | **≈ ₹1,600** | **≈ ₹5,700** | **≈ ₹52,000** |

Notes:
- **PostGIS on Lightsail managed databases is not confirmed** in AWS documentation (PostGIS docs exist for RDS only). The plan therefore runs `postgis/postgis` in Docker on a Lightsail instance with daily `pg_dump` to S3, and moves to RDS (which documents PostGIS support) at growth stage. Check `SELECT * FROM pg_available_extensions WHERE name='postgis'` on any managed option before choosing it.
- Google Play developer account: $25 one-time (≈ ₹2,100).

## Top risks
| Risk | Impact | Mitigation |
|---|---|---|
| Cold start: no vendors in an area | Customers leave | Pilot one city, founder onboards the first 50 vendors, "invite a seller" share |
| SMS DLT registration delays | Can't log in in production | Start DLT registration in week 1; dev console OTP + Play reviewer test number |
| India Post API downtime / slowness | Location search fails | DB cache, circuit breaker, GPS fallback, warm the pilot PINs |
| PostGIS hosting | Discovery doesn't work | Docker PostGIS (documented), RDS later |
| Non-technical vendors abandon onboarding | Low supply | Resumable steps, Hindi, ≤ 4 fields per screen, assisted onboarding by ops |
| Fake vendors / spam | Trust | Admin approval, reports, suspend, phone-OTP identity |
| Solo-developer bandwidth | Delays | Modular monolith, strict phase scope, automated tests and CI |

## Launch strategy
1. Closed alpha: founder + 10 vendors + 30 customers in 3–5 PIN codes (2 weeks).
2. Pilot: one city, assisted vendor onboarding, Play Store open testing track.
3. Public launch in the pilot city once the zero-result rate is < 15% and crash-free sessions are > 99%.

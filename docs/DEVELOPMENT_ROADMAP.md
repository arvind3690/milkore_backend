# Milkore — Development Roadmap

Full prompts: `../../MILKORE_PHASE_PROMPTS.md`. Status lives in `PROGRESS.md`.

| Phase | Scope | Depends on | Parallel with |
|---|---|---|---|
| P0.1 | Repos, CLAUDE.md, docs skeletons | — | — |
| P0.2 | PRD, architecture, decisions, costs | P0.1 | — |
| B1 | NestJS foundation, envelope, security baseline, DB check, Prisma | P0.2 | F1, F2 |
| D1 | Identity, auth, audit tables + PostGIS | B1 | F1, F2 |
| D2 | Vendors, locations, service areas, media, post office cache | D1 | F1, F2 |
| D3 | Catalogue, products, price history | D2 | F1, F2 |
| D4 | Chat, call logs, communication access, reports, support | D3 | F1, F2 |
| D5 | Seeds (categories, units, admin, dev vendors) | D4 | F1, F2 |
| A1 | OTP auth, JWT, roles, /me | D5 | F1, F2 |
| A2 | Locations (India Post + Nominatim), customer location | A1 | — |
| A3 | Media uploads, vendor onboarding | A2 | — |
| A4 | Catalogue, vendor products and prices | A3 | — |
| A5 | PostGIS discovery, public vendor details | A4 | — |
| A6 | Chat REST + Socket.IO, calls, policy hook | A5 | — |
| A7 | Reports, support, admin APIs | A6 | — |
| F1 | Flutter rebrand, cleanup, Firebase removal | P0.2 | B1–D5 |
| F2 | Design system, en/hi localization | F1 | B1–D5 |
| F3 | Splash, language, location onboarding, shells | F2, A2 | — |
| F4 | Phone OTP login, role routing | F3, A1 | — |
| F5 | Customer home + discovery | F4, A5 | F7, F8 |
| F6 | Vendor details, call, chat entry | F5, A6 | — |
| F7 | Vendor onboarding stepper | F4, A3 | F5 |
| F8 | Vendor dashboard, products, prices | F7, A4 | F5 |
| F9 | Chat UI + socket | F6, A6 | — |
| F10 | Profile, support, polish | F9, A7 | W1–W3 |
| W1–W3 | Admin dashboard | A7 | F10 |
| Q1–Q2 | Testing + security hardening | all features | — |
| Q3 | Docker, CI/CD, deployment runbook | Q1 | Q2 |
| Q4 | Play Store readiness | Q2 | — |
| L1 | Pilot launch | Q3, Q4 | — |

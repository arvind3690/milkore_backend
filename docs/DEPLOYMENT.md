# Milkore — Deployment Runbook

Target (ADR-013): one **AWS Lightsail** instance (Ubuntu 24.04, 4 GB for the recommended MVP) running Docker Compose:
`caddy` (TLS + reverse proxy) → `api` (NestJS image from GHCR) → `db` (postgis/postgis:16). Photos in **S3 + CloudFront**.
Nightly `pg_dump` to S3. The admin dashboard runs on Vercel (or the same box).

> Commands that create cloud resources or touch billing are for the founder to run. Nothing here is automated against your AWS account.

## 1. One-time AWS setup (≈ 1 hour)

1. **Lightsail instance**: region Mumbai (ap-south-1), Ubuntu 24.04, 4 GB plan. Attach a **static IP**. Firewall: allow 22 (your IP only), 80, 443.
2. **DNS**: `api.milkore.in` → static IP (A record). `admin.milkore.in` → Vercel (CNAME) if used.
3. **S3 media bucket** `milkore-media-prod` (ap-south-1): Block all public access ON; CORS:
   ```json
   [{ "AllowedMethods": ["PUT"], "AllowedOrigins": ["*"], "AllowedHeaders": ["content-type", "content-length"], "MaxAgeSeconds": 300 }]
   ```
   (Uploads are presigned PUTs from the app; origin `*` is required because the app is native.)
4. **CloudFront** distribution in front of the bucket with Origin Access Control → `MEDIA_PUBLIC_BASE_URL=https://cdn.milkore.in` (or the cloudfront.net domain).
5. **S3 backup bucket** `milkore-backups-prod` with a lifecycle rule: delete objects after 14 days.
6. **IAM user** `milkore-api` with only: `s3:PutObject`, `s3:GetObject` on `milkore-media-prod/*`. A separate `milkore-backup` user with `s3:PutObject` on `milkore-backups-prod/postgres/*`.

## 2. Server bootstrap

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 awscli
sudo usermod -aG docker ubuntu && newgrp docker
sudo mkdir -p /opt/milkore/deploy && sudo chown ubuntu /opt/milkore && cd /opt/milkore
# copy docker-compose.yml and deploy/ (Caddyfile, backup.sh) from the repo
```

Create `/opt/milkore/.env.production` (chmod 600) from `.env.example` with **production values**:
`NODE_ENV=production`, fresh random secrets, `SMS_PROVIDER=msg91` + keys, `STORAGE_PROVIDER=s3` + bucket/keys,
`MEDIA_PUBLIC_BASE_URL`, `CORS_ORIGINS=https://admin.milkore.in`, `API_PUBLIC_URL=https://api.milkore.in`,
`GEOCODER_USER_AGENT=Milkore/1.0 (+support@milkore.in)`, `SEED_ADMIN_EMAIL/PASSWORD`,
`PUSH_PROVIDER=fcm` plus the Firebase service-account key: either `FIREBASE_SERVICE_ACCOUNT_BASE64=$(base64 -w0 key.json)`
or mount the file read-only and set `FIREBASE_SERVICE_ACCOUNT_PATH`. Never bake the key into the image or commit it.
Create `/opt/milkore/.env` with `POSTGRES_PASSWORD=<random>` (compose variable).

Edit `deploy/Caddyfile` to your domain.

## 3. First deploy

```bash
docker login ghcr.io -u arvind3690            # PAT with read:packages
docker compose pull
docker compose up -d db
docker compose --profile ops run --rm migrate  # prisma migrate deploy (never reset)
docker compose run --rm api node dist-seed/seed.js   # categories, units, first super admin (idempotent)
docker compose up -d api caddy
curl -s https://api.milkore.in/api/v1/health    # → db: up, postgis: installed
```

> `dist-seed/seed.js` is the compiled base seed. Never run `seed:dev` (demo vendors) in production — it refuses anyway.

## 4. Routine deploy (after CI pushes a new image)

```bash
cd /opt/milkore
docker compose pull api
docker compose --profile ops run --rm migrate
docker compose up -d api
docker image prune -f
```

**Rollback**: `API_IMAGE=ghcr.io/arvind3690/milkore_backend:<previous-sha> docker compose up -d api`.
Migrations are additive by policy; if a migration must be undone, restore the pre-deploy dump (below) — never `migrate reset`.

## 5. Backups and restore

Cron (root): `30 2 * * * BACKUP_BUCKET=milkore-backups-prod /opt/milkore/deploy/backup.sh >> /var/log/milkore-backup.log 2>&1`

Restore drill (do it once before launch, then monthly):
```bash
aws s3 cp s3://milkore-backups-prod/postgres/<stamp>.dump /tmp/r.dump
docker compose exec -T db createdb -U milkore milkore_restore
docker compose exec -T db pg_restore -U milkore -d milkore_restore < /tmp/r.dump
docker compose exec -T db psql -U milkore -d milkore_restore -c "select count(*) from users"
```
Also take a manual dump **before every migration**.

## 6. Monitoring

- Uptime: UptimeRobot (free) on `/api/v1/health` every 5 min, alert by email/SMS.
- Errors: Sentry (free tier) — add `@sentry/nestjs` when ready (not yet installed; ADR backlog).
- Logs: `docker compose logs -f api` (JSON pino logs; phone numbers masked, tokens/OTPs never logged).
- Disk: Lightsail metric alarm at 80 %.

## 7. Admin dashboard

Vercel: import `milkore_admin`, set `MILKORE_API_URL=https://api.milkore.in/api/v1` and
`NEXT_PUBLIC_MILKORE_API_ORIGIN=https://cdn.milkore.in` (or the API origin), custom domain `admin.milkore.in`.
Add the dashboard origin to the API's `CORS_ORIGINS` (only needed for direct browser calls; the dashboard proxies server-side).

## 8. Secrets inventory

| Secret | Lives in | Rotate |
|---|---|---|
| DATABASE password | server `.env` | yearly |
| JWT_SECRET / ADMIN_JWT_SECRET / REFRESH_TOKEN_PEPPER / OTP_HMAC_SECRET | server `.env.production` | on suspicion (rotating logs everyone out) |
| MSG91 key | server `.env.production` | yearly |
| AWS keys (api, backup) | server `.env.production` / instance profile | 90 days |
| GHCR read token | server docker login | yearly |
| Android upload keystore + passwords | founder's password manager + offline backup | never lose it |
| GitHub Actions | `GITHUB_TOKEN` only (no extra secrets needed today) | — |

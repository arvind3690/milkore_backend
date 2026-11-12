#!/usr/bin/env bash
# Nightly PostgreSQL backup to S3 (cron: 30 2 * * * /opt/milkore/deploy/backup.sh)
# Needs: aws CLI configured with a role/user that can only PutObject to the backup bucket.
set -euo pipefail
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="/tmp/milkore-${STAMP}.dump"
docker compose -f /opt/milkore/docker-compose.yml exec -T db pg_dump -U milkore -d milkore -Fc > "$FILE"
aws s3 cp "$FILE" "s3://${BACKUP_BUCKET:?set BACKUP_BUCKET}/postgres/${STAMP}.dump" --storage-class STANDARD_IA
rm -f "$FILE"
# Retention (14 days) is enforced by an S3 lifecycle rule on the bucket, not here.

/**
 * Prepares an isolated test database (<dbname>_test on the same server), applies all
 * migrations and the base seed. Never touches the development database.
 * Usage: node scripts/test-db.cjs  (prints nothing secret)
 */
require('dotenv').config({ quiet: true });
const { execSync } = require('node:child_process');
const { Client } = require('pg');

const base = new URL(process.env.DATABASE_URL);
const devDb = base.pathname.slice(1);
const testDb = `${devDb}_test`;
const testUrl = new URL(base.toString());
testUrl.pathname = `/${testDb}`;

(async () => {
  const admin = new Client({ connectionString: base.toString() });
  await admin.connect();
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [testDb]);
  if (!rowCount) {
    await admin.query(`CREATE DATABASE "${testDb.replace(/"/g, '')}"`);
    console.log(`created database ${testDb}`);
  }
  await admin.end();
  const env = { ...process.env, DATABASE_URL: testUrl.toString(), NODE_ENV: 'test' };
  execSync('npx prisma migrate deploy', { stdio: ['ignore', 'ignore', 'inherit'], env });
  execSync('npx ts-node prisma/seed.ts', { stdio: ['ignore', 'ignore', 'inherit'], env });
  console.log(`test database ${testDb} migrated and seeded`);
})().catch((e) => {
  console.error('test-db failed:', e.message.replace(base.toString(), '<url>'));
  process.exit(1);
});

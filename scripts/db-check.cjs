require('dotenv').config({ path: process.cwd() + '/.env' });
const { Client } = require('pg');
const url = process.env.DATABASE_URL;
if (!url) { console.log('DATABASE_URL missing'); process.exit(1); }
const u = new URL(url);
console.log('host type:', ['localhost','127.0.0.1'].includes(u.hostname) ? 'local' : 'remote', '| port:', u.port || 5432, '| db name set:', !!u.pathname.slice(1), '| schema param:', u.searchParams.get('schema') || '(none)');
const c = new Client({ connectionString: url });
c.connect().then(async () => {
  const v = await c.query('select version()'); console.log(v.rows[0].version.split(',')[0]);
  const a = await c.query("select name, default_version, installed_version from pg_available_extensions where name in ('postgis','pg_trgm','pgcrypto','citext')"); console.table(a.rows);
  const t = await c.query("select count(*)::int n from information_schema.tables where table_schema='public'"); console.log('public tables:', t.rows[0].n);
  const r = await c.query("select rolsuper, rolcreatedb from pg_roles where rolname = current_user"); console.log('role super:', r.rows[0].rolsuper, 'createdb:', r.rows[0].rolcreatedb);
  await c.end();
}).catch(e => { console.log('CONNECT FAILED:', e.code, (e.message||'').replace(url,'<url>')); process.exit(1); });

// Points the e2e run at the isolated <db>_test database (prepared by scripts/test-db.cjs).
import 'dotenv/config';

const url = new URL(process.env.DATABASE_URL as string);
if (!url.pathname.endsWith('_test')) url.pathname = `${url.pathname}_test`;
process.env.DATABASE_URL = url.toString();
process.env.NODE_ENV = 'test';
process.env.STORAGE_PROVIDER = 'local';
process.env.SMS_PROVIDER = 'console';
process.env.OTP_TEST_ENABLED = 'false';

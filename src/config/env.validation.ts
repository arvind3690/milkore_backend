import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['true', '1', 'yes'].includes(v.toLowerCase())));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  API_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  CORS_ORIGINS: z.string().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).optional(),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  REFRESH_TOKEN_PEPPER: z.string().min(16),
  ADMIN_JWT_SECRET: z.string().min(16),
  ADMIN_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
  OTP_HMAC_SECRET: z.string().min(16),

  SMS_PROVIDER: z.enum(['console', 'msg91']).default('console'),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_TEMPLATE_ID: z.string().optional(),
  OTP_TEST_ENABLED: bool.default(false),
  OTP_TEST_PHONES: z.string().default(''),
  OTP_TEST_CODE: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
  /** Development only: one fixed OTP for every phone (needs SMS_PROVIDER=console; refused in production). */
  OTP_DEV_STATIC_CODE: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),

  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  AWS_REGION: z.string().default('ap-south-1'),
  S3_BUCKET: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  MEDIA_PUBLIC_BASE_URL: z.string().url().optional(),

  PINCODE_API_URL: z.string().url().default('https://api.postalpincode.in'),
  NOMINATIM_URL: z.string().url().default('https://nominatim.openstreetmap.org'),
  GEOCODER_USER_AGENT: z.string().default('Milkore/0.1'),

  /** Push notifications: "console" only logs (development/tests); "fcm" sends through Firebase Cloud Messaging. */
  PUSH_PROVIDER: z.enum(['console', 'fcm']).default('console'),
  /** Path to the Firebase service-account JSON (never committed). */
  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().default('./firebase-service-account.json'),
  /** Alternative for containers/CI: the same JSON, base64-encoded. Wins over the path when set. */
  FIREBASE_SERVICE_ACCOUNT_BASE64: z.string().optional(),

  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(10).optional(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    if (env.SMS_PROVIDER === 'console') {
      throw new Error('SMS_PROVIDER=console is not allowed in production');
    }
    if (env.OTP_DEV_STATIC_CODE) {
      throw new Error('OTP_DEV_STATIC_CODE is not allowed in production');
    }
    if (env.PUSH_PROVIDER === 'console') {
      throw new Error('PUSH_PROVIDER=console is not allowed in production');
    }
    if (env.STORAGE_PROVIDER === 's3' && !env.S3_BUCKET) {
      throw new Error('S3_BUCKET is required for s3 storage');
    }
  }
  return env;
}

import { validateEnv } from '../../config/env.validation';
import { OtpService } from './otp.service';

/** Minimal stand-ins: only what `request()` touches. */
function setup(env: Record<string, unknown>) {
  const created: { otpHash: string }[] = [];
  const prisma = {
    otpRequest: {
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(({ data }: { data: { otpHash: string } }) => {
        created.push(data);
        return Promise.resolve(data);
      }),
    },
  };
  const sms = { sendOtp: jest.fn().mockResolvedValue(undefined) };
  const config = { get: (key: string) => env[key] };
  const service = new OtpService(prisma as never, sms as never, config as never);
  return { service, sms, created };
}

const base = { NODE_ENV: 'development', SMS_PROVIDER: 'console', OTP_HMAC_SECRET: 'x'.repeat(16), OTP_TEST_PHONES: '' };

describe('OtpService dev static code', () => {
  it('uses OTP_DEV_STATIC_CODE for any phone and skips SMS', async () => {
    const { service, sms } = setup({ ...base, OTP_DEV_STATIC_CODE: '234567' });
    await service.request('+919876543210', '1.2.3.4');
    expect(sms.sendOtp).not.toHaveBeenCalled();
  });

  it('is ignored with a real SMS provider', async () => {
    const { service, sms } = setup({ ...base, SMS_PROVIDER: 'msg91', OTP_DEV_STATIC_CODE: '234567' });
    await service.request('+919876543210', '1.2.3.4');
    expect(sms.sendOtp).toHaveBeenCalledTimes(1);
    expect(sms.sendOtp.mock.calls[0][1]).toMatch(/^\d{6}$/);
  });

  it('sends a random OTP when unset', async () => {
    const { service, sms } = setup(base);
    await service.request('+919876543210', '1.2.3.4');
    expect(sms.sendOtp).toHaveBeenCalledTimes(1);
  });

  it('is refused in production', () => {
    const secrets = {
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      JWT_SECRET: 'a'.repeat(16),
      REFRESH_TOKEN_PEPPER: 'b'.repeat(16),
      ADMIN_JWT_SECRET: 'c'.repeat(16),
      OTP_HMAC_SECRET: 'd'.repeat(16),
    };
    expect(() =>
      validateEnv({ ...secrets, NODE_ENV: 'production', SMS_PROVIDER: 'msg91', OTP_DEV_STATIC_CODE: '234567' }),
    ).toThrow(/OTP_DEV_STATIC_CODE/);
  });
});

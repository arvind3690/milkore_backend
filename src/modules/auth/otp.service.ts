import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { BadRequestException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SmsProvider } from './sms.provider';

export const OTP_TTL_SECONDS = 300;
export const OTP_RESEND_SECONDS = 30;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_PER_PHONE_PER_HOUR = 5;
export const OTP_MAX_PER_IP_PER_HOUR = 20;

export class RateLimitedException extends HttpException {
  constructor(message: string, readonly retryAfterSeconds: number) {
    super({ message, retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsProvider,
    private readonly config: AppConfig,
  ) {}

  private hash(phone: string, otp: string): string {
    return createHmac('sha256', this.config.get('OTP_HMAC_SECRET')).update(`${phone}:${otp}`).digest('hex');
  }

  /**
   * Fixed codes that skip SMS: OTP_DEV_STATIC_CODE (every phone, development with the console
   * SMS provider only) or the Play Store review numbers (OTP_TEST_ENABLED=true).
   */
  private testCodeFor(phone: string): string | null {
    const devCode = this.config.get('OTP_DEV_STATIC_CODE');
    if (devCode && this.config.get('SMS_PROVIDER') === 'console' && this.config.get('NODE_ENV') !== 'production') {
      return devCode;
    }
    if (!this.config.get('OTP_TEST_ENABLED')) return null;
    const code = this.config.get('OTP_TEST_CODE');
    const phones = this.config
      .get('OTP_TEST_PHONES')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    return code && phones.includes(phone) ? code : null;
  }

  async request(phone: string, ip: string, deviceId?: string) {
    const hourAgo = new Date(Date.now() - 3_600_000);
    const last = await this.prisma.otpRequest.findFirst({
      where: { phone },
      orderBy: { createdAt: 'desc' },
    });
    if (last) {
      const waited = (Date.now() - last.createdAt.getTime()) / 1000;
      if (waited < OTP_RESEND_SECONDS) {
        const retry = Math.ceil(OTP_RESEND_SECONDS - waited);
        throw new RateLimitedException(`Please wait ${retry} seconds before asking for a new OTP.`, retry);
      }
    }
    const [perPhone, perIp] = await Promise.all([
      this.prisma.otpRequest.count({ where: { phone, createdAt: { gte: hourAgo } } }),
      this.prisma.otpRequest.count({ where: { ipAddress: ip, createdAt: { gte: hourAgo } } }),
    ]);
    if (perPhone >= OTP_MAX_PER_PHONE_PER_HOUR || perIp >= OTP_MAX_PER_IP_PER_HOUR) {
      throw new RateLimitedException('Too many OTP requests. Please try again after some time.', 3600);
    }

    const otp = this.testCodeFor(phone) ?? String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.otpRequest.create({
      data: {
        phone,
        otpHash: this.hash(phone, otp),
        expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
        ipAddress: ip,
        deviceId: deviceId ?? null,
      },
    });
    if (!this.testCodeFor(phone)) await this.sms.sendOtp(phone, otp);
    return { resendAfterSeconds: OTP_RESEND_SECONDS, expiresInSeconds: OTP_TTL_SECONDS };
  }

  /** Throws 400 for every failure (never 401: the app must not treat a wrong OTP as logout). */
  async verify(phone: string, otp: string): Promise<void> {
    const record = await this.prisma.otpRequest.findFirst({
      where: { phone, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!record || record.expiresAt < new Date()) {
      throw new BadRequestException('This OTP has expired. Please request a new one.');
    }
    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      throw new BadRequestException('Too many wrong attempts. Please request a new OTP.');
    }
    const expected = Buffer.from(record.otpHash, 'hex');
    const actual = Buffer.from(this.hash(phone, otp), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      const updated = await this.prisma.otpRequest.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      const left = OTP_MAX_ATTEMPTS - updated.attempts;
      throw new BadRequestException(
        left > 0 ? `Wrong OTP. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many wrong attempts. Please request a new OTP.',
      );
    }
    const { count } = await this.prisma.otpRequest.updateMany({
      where: { id: record.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (count === 0) throw new BadRequestException('This OTP was already used. Please request a new one.');
  }
}

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { normalizeIndianMobile } from '../../common/utils/phone';
import { PrismaService } from '../../prisma/prisma.service';
import { toUserDto } from '../users/user.mapper';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  phoneOrThrow(raw: string): string {
    const phone = normalizeIndianMobile(raw);
    if (!phone) {
      throw new BadRequestException({
        message: 'Please enter a valid 10-digit mobile number.',
        errors: { phone: ['Enter a valid 10-digit Indian mobile number'] },
      });
    }
    return phone;
  }

  requestOtp(rawPhone: string, ip: string, deviceId?: string) {
    return this.otp.request(this.phoneOrThrow(rawPhone), ip, deviceId);
  }

  async verifyOtp(rawPhone: string, code: string, ip: string, deviceId?: string, userAgent?: string) {
    const phone = this.phoneOrThrow(rawPhone);
    await this.otp.verify(phone, code);

    let user = await this.prisma.user.findUnique({ where: { phone } });
    const isNewUser = !user;
    if (!user) {
      user = await this.prisma.user.create({ data: { phone, customerProfile: { create: {} } } });
    }
    if (user.status === 'SUSPENDED') {
      throw new ForbiddenException('Your account is suspended. Please contact Milkore support.');
    }
    user = await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const vendor = await this.prisma.vendorProfile.findUnique({
      where: { userId: user.id },
      select: { approvalStatus: true },
    });

    const pair = await this.tokens.issue(user, { deviceId, userAgent });
    await this.audit.record({
      actorType: 'USER',
      actorId: user.id,
      action: isNewUser ? 'auth.signup' : 'auth.login',
      entityType: 'user',
      entityId: user.id,
      ip,
    });
    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      expiresIn: pair.expiresIn,
      isNewUser: isNewUser || !user.name,
      user: toUserDto(user, vendor),
    };
  }

  refresh(refreshToken: string, userAgent?: string) {
    return this.tokens.rotate(refreshToken, userAgent);
  }

  async logout(userId: string, refreshToken: string | undefined, ip: string, pushToken?: string) {
    if (refreshToken) await this.tokens.revokeByToken(refreshToken, userId);
    else await this.tokens.revokeAllForUser(userId);
    // Logged-out devices stop getting this account's pushes. "Log out everywhere" removes them all.
    if (pushToken) await this.prisma.deviceToken.deleteMany({ where: { userId, token: pushToken } });
    else if (!refreshToken) await this.prisma.deviceToken.deleteMany({ where: { userId } });
    await this.audit.record({ actorType: 'USER', actorId: userId, action: 'auth.logout', entityType: 'user', entityId: userId, ip });
    return null;
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { vendorProfile: { select: { approvalStatus: true } } },
    });
    if (!user) throw new NotFoundException('Account not found.');
    return toUserDto(user, user.vendorProfile);
  }

  async updateMe(userId: string, data: { name?: string; preferredLanguage?: 'en' | 'hi' }) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { ...(data.name ? { name: data.name.trim() } : {}), ...(data.preferredLanguage ? { preferredLanguage: data.preferredLanguage } : {}) },
    });
    return this.me(userId);
  }

  /** Account deletion (Play Store requirement): anonymise, hide vendor listing, revoke sessions. */
  async deleteMe(userId: string, ip: string) {
    const tombstone = `del_${userId.replace(/-/g, '').slice(0, 12)}`;
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { status: 'DELETED', deletedAt: new Date(), phone: tombstone, name: null },
      }),
      this.prisma.vendorProfile.updateMany({
        where: { userId },
        data: { deletedAt: new Date(), isAvailable: false, contactPhone: null },
      }),
      this.prisma.customerProfile.updateMany({
        where: { userId },
        data: { addressLabel: null, pincode: null, city: null },
      }),
      this.prisma.$executeRaw`UPDATE customer_profiles SET location = NULL WHERE user_id = ${userId}::uuid`,
      this.prisma.deviceToken.deleteMany({ where: { userId } }),
      this.prisma.notification.deleteMany({ where: { userId } }),
      this.prisma.notificationPreference.deleteMany({ where: { userId } }),
    ]);
    await this.tokens.revokeAllForUser(userId);
    await this.audit.record({ actorType: 'USER', actorId: userId, action: 'account.delete', entityType: 'user', entityId: userId, ip });
    return null;
  }
}

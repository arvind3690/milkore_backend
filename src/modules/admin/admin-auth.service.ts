import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AdminUser } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AuditService } from '../../common/audit/audit.service';
import { ADMIN_JWT_AUDIENCE, AdminJwtPayload } from '../../common/auth/auth.types';
import { AppConfig } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
const ADMIN_REFRESH_DAYS = 7;
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', 12);

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits), accepting ±1 step of clock drift. */
export function verifyTotp(base32Secret: string, code: string, now = Date.now()): boolean {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of base32Secret.replace(/=+$/, '').toUpperCase()) {
    const v = alphabet.indexOf(c);
    if (v < 0) return false;
    bits += v.toString(2).padStart(5, '0');
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const step = Math.floor(now / 30_000);
  for (const offset of [-1, 0, 1]) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step + offset));
    const hmac = createHmac('sha1', key).update(counter).digest();
    const o = hmac[hmac.length - 1]! & 0xf;
    const value = ((hmac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
    if (value.length === code.length && timingSafeEqual(Buffer.from(value), Buffer.from(code))) return true;
  }
  return false;
}

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  private hash(token: string) {
    return createHmac('sha256', this.config.get('REFRESH_TOKEN_PEPPER')).update(`admin:${token}`).digest('hex');
  }

  private dto(a: AdminUser) {
    return { id: a.id, email: a.email, name: a.name, role: a.role, status: a.status, totpEnabled: Boolean(a.totpSecret), lastLoginAt: a.lastLoginAt };
  }

  private async issue(admin: AdminUser, familyId: string = randomUUID()) {
    const expiresIn = this.config.get('ADMIN_ACCESS_TTL_SECONDS');
    const payload: AdminJwtPayload = { sub: admin.id, role: admin.role, typ: 'admin' };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.get('ADMIN_JWT_SECRET'),
      audience: ADMIN_JWT_AUDIENCE,
      expiresIn,
    });
    const refreshToken = randomBytes(48).toString('base64url');
    const session = await this.prisma.adminSession.create({
      data: {
        adminId: admin.id,
        tokenHash: this.hash(refreshToken),
        familyId,
        expiresAt: new Date(Date.now() + ADMIN_REFRESH_DAYS * 86_400_000),
      },
    });
    return { accessToken, refreshToken, expiresIn, sessionId: session.id, admin: this.dto(admin) };
  }

  async login(email: string, password: string, totp: string | undefined, ip: string) {
    const admin = await this.prisma.adminUser.findUnique({ where: { email: email.trim().toLowerCase() } });
    const fail = () => new UnauthorizedException('Wrong email or password.');
    if (!admin || admin.status !== 'ACTIVE') {
      await bcrypt.compare(password, DUMMY_HASH); // same timing whether or not the email exists
      throw fail();
    }
    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      throw new HttpException('Too many failed attempts. Try again in 15 minutes.', HttpStatus.TOO_MANY_REQUESTS);
    }
    const ok = (await bcrypt.compare(password, admin.passwordHash)) && (!admin.totpSecret || (totp ? verifyTotp(admin.totpSecret, totp) : false));
    if (!ok) {
      const failures = admin.failedLoginCount + 1;
      await this.prisma.adminUser.update({
        where: { id: admin.id },
        data: failures >= MAX_FAILURES
          ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) }
          : { failedLoginCount: failures },
      });
      await this.audit.record({ actorType: 'ADMIN', actorId: admin.id, action: 'admin.login_failed', entityType: 'admin', entityId: admin.id, ip });
      if (admin.totpSecret && !totp) throw new UnauthorizedException('Enter the 6-digit code from your authenticator app.');
      throw fail();
    }
    const updated = await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    await this.audit.record({ actorType: 'ADMIN', actorId: admin.id, action: 'admin.login', entityType: 'admin', entityId: admin.id, ip });
    const { sessionId: _s, ...out } = await this.issue(updated);
    return out;
  }

  async refresh(refreshToken: string) {
    const session = await this.prisma.adminSession.findUnique({ where: { tokenHash: this.hash(refreshToken) }, include: { admin: true } });
    const expired = new UnauthorizedException('Your session has expired. Please log in again.');
    if (!session) throw expired;
    if (session.revokedAt || session.expiresAt < new Date() || session.admin.status !== 'ACTIVE') {
      await this.prisma.adminSession.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw expired;
    }
    const next = await this.issue(session.admin, session.familyId);
    const { count } = await this.prisma.adminSession.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: new Date(), replacedById: next.sessionId },
    });
    if (!count) throw expired;
    const { sessionId: _s, ...out } = next;
    return out;
  }

  async logout(adminId: string, refreshToken?: string) {
    if (refreshToken) {
      const s = await this.prisma.adminSession.findUnique({ where: { tokenHash: this.hash(refreshToken) } });
      if (s && s.adminId === adminId) {
        await this.prisma.adminSession.updateMany({ where: { familyId: s.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      }
    } else {
      await this.prisma.adminSession.updateMany({ where: { adminId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    return null;
  }

  async me(adminId: string) {
    return this.dto(await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } }));
  }

  async listAdmins() {
    const admins = await this.prisma.adminUser.findMany({ orderBy: { createdAt: 'asc' } });
    return admins.map((a) => this.dto(a));
  }

  async createAdmin(actorId: string, data: { email: string; name: string; password: string; role: 'SUPER_ADMIN' | 'MODERATOR' }, ip: string) {
    const admin = await this.prisma.adminUser.create({
      data: { email: data.email.trim().toLowerCase(), name: data.name.trim(), role: data.role, passwordHash: await bcrypt.hash(data.password, 12) },
    });
    await this.audit.record({ actorType: 'ADMIN', actorId, action: 'admin.create', entityType: 'admin', entityId: admin.id, metadata: { role: data.role }, ip });
    return this.dto(admin);
  }

  async setAdminStatus(actorId: string, adminId: string, status: 'ACTIVE' | 'DISABLED', ip: string) {
    if (actorId === adminId) throw new HttpException('You cannot change your own status.', HttpStatus.BAD_REQUEST);
    const admin = await this.prisma.adminUser.update({ where: { id: adminId }, data: { status } });
    if (status === 'DISABLED') {
      await this.prisma.adminSession.updateMany({ where: { adminId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await this.audit.record({ actorType: 'ADMIN', actorId, action: `admin.${status.toLowerCase()}`, entityType: 'admin', entityId: adminId, ip });
    return this.dto(admin);
  }
}

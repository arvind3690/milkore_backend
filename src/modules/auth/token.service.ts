import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import { AppConfig } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { APP_JWT_AUDIENCE, AppJwtPayload } from '../../common/auth/auth.types';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/** Issues access JWTs and rotating opaque refresh tokens (only their HMAC is stored). */
@Injectable()
export class TokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
  ) {}

  hash(token: string): string {
    return createHmac('sha256', this.config.get('REFRESH_TOKEN_PEPPER')).update(token).digest('hex');
  }

  async issue(
    user: Pick<User, 'id' | 'role'>,
    opts: { familyId?: string; deviceId?: string | null; userAgent?: string | null } = {},
  ): Promise<TokenPair & { sessionId: string }> {
    const expiresIn = this.config.get('JWT_ACCESS_TTL_SECONDS');
    const payload: AppJwtPayload = { sub: user.id, role: user.role, typ: 'access' };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.get('JWT_SECRET'),
      audience: APP_JWT_AUDIENCE,
      expiresIn,
    });
    const refreshToken = randomBytes(48).toString('base64url');
    const session = await this.prisma.refreshSession.create({
      data: {
        userId: user.id,
        tokenHash: this.hash(refreshToken),
        familyId: opts.familyId ?? randomUUID(),
        deviceId: opts.deviceId ?? null,
        userAgent: opts.userAgent?.slice(0, 256) ?? null,
        expiresAt: new Date(Date.now() + this.config.get('REFRESH_TTL_DAYS') * 86_400_000),
      },
    });
    return { accessToken, refreshToken, expiresIn, sessionId: session.id };
  }

  /**
   * Rotates a refresh token. Reusing an already-rotated token revokes the whole family
   * (a stolen token can only be used once before everything is logged out).
   */
  async rotate(refreshToken: string, userAgent?: string | null): Promise<TokenPair> {
    const session = await this.prisma.refreshSession.findUnique({
      where: { tokenHash: this.hash(refreshToken) },
      include: { user: { select: { id: true, role: true, status: true } } },
    });
    if (!session) throw new UnauthorizedException('Your session has expired. Please log in again.');

    if (session.revokedAt) {
      await this.revokeFamily(session.familyId);
      throw new UnauthorizedException('Your session has expired. Please log in again.');
    }
    if (session.expiresAt < new Date() || session.user.status !== 'ACTIVE') {
      await this.revokeFamily(session.familyId);
      throw new UnauthorizedException('Your session has expired. Please log in again.');
    }

    const next = await this.issue(session.user, {
      familyId: session.familyId,
      deviceId: session.deviceId,
      userAgent,
    });
    // Conditional update: if a parallel refresh already rotated this token, treat it as reuse.
    const { count } = await this.prisma.refreshSession.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: new Date(), replacedById: next.sessionId, lastUsedAt: new Date() },
    });
    if (count === 0) {
      await this.revokeFamily(session.familyId);
      throw new UnauthorizedException('Your session has expired. Please log in again.');
    }
    return { accessToken: next.accessToken, refreshToken: next.refreshToken, expiresIn: next.expiresIn };
  }

  async revokeByToken(refreshToken: string, userId: string): Promise<void> {
    const session = await this.prisma.refreshSession.findUnique({
      where: { tokenHash: this.hash(refreshToken) },
    });
    if (session && session.userId === userId) await this.revokeFamily(session.familyId);
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshSession.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

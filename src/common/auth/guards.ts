import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ApiBearerAuth } from '@nestjs/swagger';
import { AppConfig } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../decorators';
import {
  ADMIN_JWT_AUDIENCE,
  AdminJwtPayload,
  APP_JWT_AUDIENCE,
  AppJwtPayload,
  AuthedRequest,
} from './auth.types';

export const IS_ADMIN_ROUTE_KEY = 'isAdminRoute';
export const ADMIN_ROLES_KEY = 'adminRoles';

function bearer(req: AuthedRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

/**
 * Global guard for app users. Protected by default; `@Public()` routes still read an
 * optional token so they can personalise. Suspended/deleted users get 403.
 */
@Injectable()
export class AppAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_ADMIN_ROUTE_KEY, targets)) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) ?? false;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = bearer(req);

    if (!token) {
      if (isPublic) return true;
      throw new UnauthorizedException('Please log in to continue.');
    }

    let payload: AppJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<AppJwtPayload>(token, {
        secret: this.config.get('JWT_SECRET'),
        audience: APP_JWT_AUDIENCE,
      });
    } catch {
      if (isPublic) return true;
      throw new UnauthorizedException('Your session has expired.');
    }
    if (payload.typ !== 'access') throw new UnauthorizedException('Invalid token.');

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, status: true },
    });
    if (!user || user.status === 'DELETED') throw new UnauthorizedException('Account not found.');
    if (user.status === 'SUSPENDED') {
      throw new ForbiddenException('Your account is suspended. Please contact Milkore support.');
    }
    // The role in the DB wins over the token (role upgrades take effect immediately).
    req.user = { id: user.id, role: user.role };

    const roles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, targets);
    if (roles?.length && !roles.includes(user.role)) {
      throw new ForbiddenException('You do not have access to this.');
    }
    return true;
  }
}

/** Guard for /admin routes: separate secret + audience, so app tokens never work here. */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = bearer(req);
    if (!token) throw new UnauthorizedException('Please log in.');

    let payload: AdminJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<AdminJwtPayload>(token, {
        secret: this.config.get('ADMIN_JWT_SECRET'),
        audience: ADMIN_JWT_AUDIENCE,
      });
    } catch {
      throw new UnauthorizedException('Your session has expired.');
    }
    if (payload.typ !== 'admin') throw new UnauthorizedException('Invalid token.');

    const admin = await this.prisma.adminUser.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, status: true },
    });
    if (!admin || admin.status !== 'ACTIVE') throw new UnauthorizedException('Admin not active.');
    req.admin = { id: admin.id, role: admin.role };

    const roles = this.reflector.getAllAndOverride<string[]>(ADMIN_ROLES_KEY, targets);
    if (roles?.length && !roles.includes(admin.role)) {
      throw new ForbiddenException('Only a super admin can do this.');
    }
    return true;
  }
}

/** Marks a controller/route as admin-only (optionally restricted to admin roles). */
export const AdminRoute = (...roles: Array<'SUPER_ADMIN' | 'MODERATOR'>) =>
  applyDecorators(
    SetMetadata(IS_ADMIN_ROUTE_KEY, true),
    SetMetadata(ADMIN_ROLES_KEY, roles),
    UseGuards(AdminAuthGuard),
    ApiBearerAuth(),
  );

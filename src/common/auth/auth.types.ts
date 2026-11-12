import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** The authenticated app user on `req.user`. */
export interface AuthUser {
  id: string;
  role: 'CUSTOMER' | 'VENDOR';
}

/** The authenticated dashboard admin on `req.admin`. */
export interface AuthAdmin {
  id: string;
  role: 'SUPER_ADMIN' | 'MODERATOR';
}

export interface AppJwtPayload {
  sub: string;
  role: AuthUser['role'];
  typ: 'access';
}

export interface AdminJwtPayload {
  sub: string;
  role: AuthAdmin['role'];
  typ: 'admin';
}

export type AuthedRequest = Request & { user?: AuthUser; admin?: AuthAdmin };

export const APP_JWT_AUDIENCE = 'milkore-app';
export const ADMIN_JWT_AUDIENCE = 'milkore-admin';

/** The current app user. Undefined on public routes without a token. */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser | undefined =>
    ctx.switchToHttp().getRequest<AuthedRequest>().user,
);

export const CurrentAdmin = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthAdmin | undefined =>
    ctx.switchToHttp().getRequest<AuthedRequest>().admin,
);

/** Client IP (honours `trust proxy`). */
export function clientIp(req: Request): string {
  return (req.ip ?? req.socket?.remoteAddress ?? 'unknown').slice(0, 64);
}

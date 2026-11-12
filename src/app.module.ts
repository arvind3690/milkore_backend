import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuditModule } from './common/audit/audit.service';
import { AppAuthGuard } from './common/auth/guards';
import { AppConfig } from './config/app-config.service';
import { AppConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.service';
import { FEATURE_MODULES } from './modules';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        forRoutes: ['{*path}'],
        pinoHttp: {
          level: config.get('LOG_LEVEL') ?? (config.isProduction ? 'info' : config.get('NODE_ENV') === 'test' ? 'silent' : 'debug'),
          genReqId: (req, res) => {
            const existing = req.headers['x-request-id'];
            const id = typeof existing === 'string' && existing.length <= 64 ? existing : randomUUID();
            res.setHeader('x-request-id', id);
            return id;
          },
          // Secrets and personal data never reach the logs.
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers.infojson',
              'res.headers["set-cookie"]',
            ],
            censor: '[redacted]',
          },
          serializers: {
            req: (req: { id: string; method: string; url: string }) => ({
              id: req.id,
              method: req.method,
              url: req.url?.split('?')[0],
            }),
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },
          autoLogging: { ignore: (req) => req.url?.startsWith('/api/v1/health') ?? false },
          transport: config.isDevelopment
            ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
            : undefined,
        },
      }),
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
      // e2e tests log in many times from one IP; OTP-specific limits in OtpService still apply.
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    JwtModule.register({ global: true }),
    PrismaModule,
    AuditModule,
    ...FEATURE_MODULES,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AppAuthGuard },
  ],
})
export class AppModule {}

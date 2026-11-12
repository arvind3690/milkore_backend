import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { raw } from 'express';
import helmet from 'helmet';
import { AppConfig } from './config/app-config.service';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { createValidationPipe } from './common/utils/validation';

export const API_PREFIX = 'api/v1';

/** Global HTTP setup shared by main.ts and the e2e tests. */
export function configureApp(app: INestApplication): void {
  const config = app.get(AppConfig);
  // Raw image bytes for the development upload endpoint (S3 uploads never hit the API).
  app.use(`/${API_PREFIX}/media/local-upload`, raw({ type: () => true, limit: '6mb' }));
  app.setGlobalPrefix(API_PREFIX);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.enableCors({
    origin: config.corsOrigins.length ? config.corsOrigins : false,
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'x-client-transport', 'InfoJson', 'x-request-id'],
    exposedHeaders: ['Retry-After', 'x-request-id'],
  });
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor(app.get(Reflector)));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
}

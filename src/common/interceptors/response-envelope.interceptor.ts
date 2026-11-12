import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { map, Observable } from 'rxjs';
import { RAW_RESPONSE_KEY, RESPONSE_MESSAGE_KEY } from '../decorators';

export interface ApiEnvelope<T> {
  statusCode: number;
  message: string;
  data: T | null;
}

/**
 * Wraps every successful HTTP response in `{ statusCode, message, data }`.
 * The Flutter app's StatusCodeMessageDataEnvelope depends on this exact shape.
 * A 204 is never sent: an empty result becomes 200 with `data: null`.
 */
@Injectable()
export class ResponseEnvelopeInterceptor<T> implements NestInterceptor<T, ApiEnvelope<T> | T> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiEnvelope<T> | T> {
    if (context.getType() !== 'http') return next.handle();
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, targets)) return next.handle();

    const message =
      this.reflector.getAllAndOverride<string>(RESPONSE_MESSAGE_KEY, targets) ?? 'Success';
    const res = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      map((data) => {
        if (res.statusCode === 204) res.status(200);
        return { statusCode: res.statusCode, message, data: data === undefined ? null : data };
      }),
    );
  }
}

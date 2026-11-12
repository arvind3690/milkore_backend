import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

export interface ErrorBody {
  statusCode: number;
  message: string;
  data: null;
  errors?: Record<string, string[]>;
}

/**
 * Turns every error into the same envelope as a success, so the app has one parser.
 * 5xx responses never expose internals (stack traces, SQL).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') return;
    const res = host.switchToHttp().getResponse<Response>();
    const body = AllExceptionsFilter.toBody(exception);
    if (body.statusCode >= 500) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }
    const retryAfter = (exception as { retryAfterSeconds?: unknown })?.retryAfterSeconds;
    if (body.statusCode === 429 && typeof retryAfter === 'number' && !res.getHeader('Retry-After')) {
      res.setHeader('Retry-After', String(retryAfter));
    }
    res.status(body.statusCode).json(body);
  }

  static toBody(exception: unknown): ErrorBody {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      let message = exception.message;
      let errors: Record<string, string[]> | undefined;
      if (typeof payload === 'object' && payload !== null) {
        const p = payload as { message?: unknown; errors?: Record<string, string[]> };
        if (typeof p.message === 'string') message = p.message;
        else if (Array.isArray(p.message)) message = p.message.join(', ');
        errors = p.errors;
      }
      if (status === HttpStatus.TOO_MANY_REQUESTS && /throttler/i.test(message)) {
        message = 'Too many requests. Please wait and try again.';
      }
      return { statusCode: status, message, data: null, ...(errors ? { errors } : {}) };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return { statusCode: 409, message: 'This record already exists.', data: null };
      }
      if (exception.code === 'P2025') {
        return { statusCode: 404, message: 'Not found.', data: null };
      }
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Something went wrong. Please try again.',
      data: null,
    };
  }
}

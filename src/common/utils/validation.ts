import { BadRequestException, ValidationError, ValidationPipe } from '@nestjs/common';

function collect(errors: ValidationError[], parent = '', out: Record<string, string[]> = {}) {
  for (const e of errors) {
    const path = parent ? `${parent}.${e.property}` : e.property;
    if (e.constraints) out[path] = Object.values(e.constraints);
    if (e.children?.length) collect(e.children, path, out);
  }
  return out;
}

/** Global pipe: strips unknown fields, rejects extras, returns `errors: { field: [...] }`. */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
    exceptionFactory: (errors) =>
      new BadRequestException({
        message: 'Please check the highlighted fields.',
        errors: collect(errors),
      }),
  });
}

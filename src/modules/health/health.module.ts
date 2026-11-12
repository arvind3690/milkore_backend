import { Controller, Get, Module } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @SkipThrottle()
  @Get()
  async check() {
    let db: 'up' | 'down' = 'down';
    let postgis: 'installed' | 'available' | 'missing' = 'missing';
    try {
      const rows = await this.prisma.$queryRaw<{ installed_version: string | null }[]>`
        SELECT installed_version FROM pg_available_extensions WHERE name = 'postgis'`;
      db = 'up';
      if (rows[0]) postgis = rows[0].installed_version ? 'installed' : 'available';
    } catch {
      db = 'down';
    }
    return {
      status: db === 'up' ? 'ok' : 'degraded',
      db,
      postgis,
      version: process.env.npm_package_version ?? '0.1.0',
    };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}

import { Body, Controller, Get, Module, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { AuthUser, CurrentUser } from '../../common/auth/auth.types';
import { Public, ResponseMessage } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfig } from '../../config/app-config.service';
import { assertInIndia } from './geo';
import { LocationsService } from './locations.service';
import {
  GeocodingProvider,
  IndiaPostPincodeProvider,
  NominatimGeocodingProvider,
  PincodeProvider,
} from './providers';

class SearchQuery {
  @ApiProperty({ example: '110001 or Baroda House' })
  @IsString()
  @Length(1, 60)
  q: string;
}

class ReverseQuery {
  @ApiProperty() @Type(() => Number) @IsNumber() lat: number;
  @ApiProperty() @Type(() => Number) @IsNumber() lng: number;
}

class PinParam {
  @IsString()
  @Matches(/^[1-9]\d{5}$/, { message: 'PIN code must be 6 digits' })
  pin: string;
}

export class SaveLocationDto {
  @ApiPropertyOptional() @IsOptional() @IsNumber() lat?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lng?: number;

  @ApiProperty({ example: 'Baroda House, New Delhi - 110001' })
  @IsString()
  @Length(2, 160)
  label: string;

  @ApiProperty({ example: '110001' })
  @IsString()
  @Matches(/^[1-9]\d{5}$/, { message: 'PIN code must be 6 digits' })
  pincode: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) city?: string;
}

@ApiTags('locations')
@Controller('locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('search')
  search(@Query() q: SearchQuery) {
    return this.locations.search(q.q);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('pincode/:pin')
  pincode(@Param() p: PinParam) {
    return this.locations.pincodeDetails(p.pin);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('reverse')
  reverse(@Query() q: ReverseQuery) {
    return this.locations.reverse(q.lat, q.lng);
  }
}

/** The saved browsing location of any logged-in user (customers and vendors both browse). */
@ApiTags('customer')
@ApiBearerAuth()
@Controller('customer/location')
export class CustomerLocationController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async get(@CurrentUser() user: AuthUser) {
    const [row] = await this.prisma.$queryRaw<
      { label: string | null; pincode: string | null; city: string | null; lat: number | null; lng: number | null }[]
    >`SELECT address_label AS label, pincode, city,
             ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
      FROM customer_profiles WHERE user_id = ${user.id}::uuid`;
    if (!row || !row.pincode) return null;
    return { ...row, lat: row.lat === null ? null : Number(row.lat), lng: row.lng === null ? null : Number(row.lng) };
  }

  @Put()
  @ResponseMessage('Location saved')
  async save(@CurrentUser() user: AuthUser, @Body() dto: SaveLocationDto) {
    const hasPoint = dto.lat !== undefined && dto.lng !== undefined;
    if (hasPoint) assertInIndia(dto.lat!, dto.lng!);
    await this.prisma.customerProfile.upsert({
      where: { userId: user.id },
      update: { addressLabel: dto.label, pincode: dto.pincode, city: dto.city ?? null },
      create: { userId: user.id, addressLabel: dto.label, pincode: dto.pincode, city: dto.city ?? null },
    });
    if (hasPoint) {
      await this.prisma.$executeRaw`UPDATE customer_profiles
        SET location = ST_SetSRID(ST_MakePoint(${dto.lng}, ${dto.lat}), 4326)::geography
        WHERE user_id = ${user.id}::uuid`;
    } else {
      await this.prisma.$executeRaw`UPDATE customer_profiles SET location = NULL WHERE user_id = ${user.id}::uuid`;
    }
    return this.get(user);
  }
}

@Module({
  controllers: [LocationsController, CustomerLocationController],
  providers: [
    LocationsService,
    { provide: PincodeProvider, inject: [AppConfig], useFactory: (c: AppConfig) => new IndiaPostPincodeProvider(c) },
    { provide: GeocodingProvider, inject: [AppConfig], useFactory: (c: AppConfig) => new NominatimGeocodingProvider(c) },
  ],
  exports: [LocationsService],
})
export class LocationsModule {}

import { Controller, Get, Module, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsNumber, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { Public } from '../../common/decorators';
import { LocationsModule } from '../locations/locations.module';
import { MediaModule } from '../media/media.module';
import { VendorsModule } from '../vendors/vendors.module';
import { DiscoveryService } from './discovery.service';

const toBool = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1';

export class DiscoveryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: 28.6315 }) @IsOptional() @Type(() => Number) @IsNumber() lat?: number;
  @ApiPropertyOptional({ example: 77.2167 }) @IsOptional() @Type(() => Number) @IsNumber() lng?: number;

  @ApiPropertyOptional({ example: '110001' })
  @IsOptional()
  @IsString()
  @Matches(/^[1-9]\d{5}$/, { message: 'PIN code must be 6 digits' })
  pincode?: string;

  @ApiPropertyOptional({ example: 'Connaught Place' }) @IsOptional() @IsString() @Length(2, 100) locality?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional({ example: 'paneer' }) @IsOptional() @IsString() @Length(1, 60) q?: string;
  @ApiPropertyOptional({ default: false }) @IsOptional() @Transform(toBool) @IsBoolean() availableOnly?: boolean;
}

class PointQueryDto {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() lat?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() lng?: number;
}

@ApiTags('discovery')
@Controller()
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('discovery/vendors')
  vendors(@Query() q: DiscoveryQueryDto) {
    return this.discovery.vendorsNear(q);
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('discovery/products')
  products(@Query() q: DiscoveryQueryDto) {
    return this.discovery.productsNear(q);
  }

  @Public()
  @Get('vendors/:id')
  details(@Param('id', ParseUUIDPipe) id: string, @Query() q: PointQueryDto) {
    const point = q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng } : undefined;
    return this.discovery.vendorDetails(id, point);
  }
}

@Module({
  imports: [LocationsModule, MediaModule, VendorsModule],
  controllers: [DiscoveryController],
  providers: [DiscoveryService],
})
export class DiscoveryModule {}

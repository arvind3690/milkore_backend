import { Body, Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { AuthUser, clientIp, CurrentUser } from '../../common/auth/auth.types';
import { Public, ResponseMessage, Roles } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { MediaModule } from '../media/media.module';
import { ProductsService } from './products.service';
import {
  VendorAvailabilityDto,
  VendorBusinessDto,
  VendorLocationDto,
  VendorPhotosDto,
  VendorServiceAreasDto,
} from './vendor.dto';
import { VendorsService } from './vendors.service';

// ─────────────────────────────── onboarding + profile ───────────────────────────────

@ApiTags('vendor-onboarding')
@ApiBearerAuth()
@Controller('vendor/onboarding')
export class VendorOnboardingController {
  constructor(private readonly vendors: VendorsService) {}

  /** Any logged-in user can start; this upgrades the account to VENDOR. */
  @Post('start')
  @HttpCode(200)
  @ResponseMessage('Vendor registration started')
  start(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.vendors.start(user.id, clientIp(req));
  }

  @Roles('VENDOR')
  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.vendors.ownerViewByUser(user.id);
  }

  @Roles('VENDOR')
  @Patch('business')
  @ResponseMessage('Saved')
  business(@CurrentUser() user: AuthUser, @Body() dto: VendorBusinessDto) {
    return this.vendors.updateBusiness(user.id, dto);
  }

  @Roles('VENDOR')
  @Patch('photos')
  @ResponseMessage('Saved')
  photos(@CurrentUser() user: AuthUser, @Body() dto: VendorPhotosDto) {
    return this.vendors.updatePhotos(user.id, dto);
  }

  @Roles('VENDOR')
  @Patch('location')
  @ResponseMessage('Saved')
  location(@CurrentUser() user: AuthUser, @Body() dto: VendorLocationDto) {
    return this.vendors.updateLocation(user.id, dto);
  }

  @Roles('VENDOR')
  @Put('service-areas')
  @ResponseMessage('Saved')
  areas(@CurrentUser() user: AuthUser, @Body() dto: VendorServiceAreasDto) {
    return this.vendors.updateServiceAreas(user.id, dto);
  }

  @Roles('VENDOR')
  @Post('submit')
  @HttpCode(200)
  @ResponseMessage('Sent for approval')
  submit(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.vendors.submit(user.id, clientIp(req));
  }
}

/** Same operations after onboarding. Name/location/photo edits on an approved shop trigger re-review. */
@ApiTags('vendor-profile')
@ApiBearerAuth()
@Roles('VENDOR')
@Controller('vendor')
export class VendorProfileController {
  constructor(private readonly vendors: VendorsService) {}

  @Get('profile')
  profile(@CurrentUser() user: AuthUser) {
    return this.vendors.ownerViewByUser(user.id);
  }

  @Patch('profile')
  @ResponseMessage('Profile updated')
  update(@CurrentUser() user: AuthUser, @Body() dto: VendorBusinessDto) {
    return this.vendors.updateBusiness(user.id, dto);
  }

  @Patch('profile/photos')
  @ResponseMessage('Photos updated')
  photos(@CurrentUser() user: AuthUser, @Body() dto: VendorPhotosDto) {
    return this.vendors.updatePhotos(user.id, dto);
  }

  @Patch('profile/location')
  @ResponseMessage('Location updated')
  location(@CurrentUser() user: AuthUser, @Body() dto: VendorLocationDto) {
    return this.vendors.updateLocation(user.id, dto);
  }

  @Put('service-areas')
  @ResponseMessage('Service areas updated')
  areas(@CurrentUser() user: AuthUser, @Body() dto: VendorServiceAreasDto) {
    return this.vendors.updateServiceAreas(user.id, dto);
  }

  @Patch('availability')
  @ResponseMessage('Availability updated')
  availability(@CurrentUser() user: AuthUser, @Body() dto: VendorAvailabilityDto) {
    return this.vendors.setAvailability(user.id, dto.isAvailable);
  }
}

// ─────────────────────────────── catalogue (A4) ───────────────────────────────

@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  private cache: { at: number; categories: unknown; units: unknown } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  private async load() {
    if (this.cache && Date.now() - this.cache.at < 600_000) return this.cache;
    const [categories, units] = await Promise.all([
      this.prisma.productCategory.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, slug: true, nameEn: true, nameHi: true, iconKey: true, sortOrder: true },
      }),
      this.prisma.unit.findMany({ orderBy: { sortOrder: 'asc' }, select: { id: true, code: true, labelEn: true, labelHi: true } }),
    ]);
    this.cache = { at: Date.now(), categories, units };
    return this.cache;
  }

  invalidate() {
    this.cache = null;
  }

  @Public()
  @Get('categories')
  async categories() {
    return (await this.load()).categories;
  }

  @Public()
  @Get('units')
  async units() {
    return (await this.load()).units;
  }
}

export class CreateProductDto {
  @ApiProperty() @IsUUID() categoryId: string;
  @ApiProperty() @IsUUID() unitId: string;
  @ApiProperty({ example: 'Cow Milk' }) @IsString() @Length(2, 80) name: string;
  @ApiPropertyOptional({ example: 'Fresh, unadulterated' }) @IsOptional() @IsString() @MaxLength(300) description?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() imageId?: string | null;

  @ApiProperty({ example: 6000, description: 'Price in paise (₹60 = 6000). ₹1 – ₹1,00,000.' })
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(10_000_000)
  pricePaise: number;

  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() isAvailable?: boolean;
}

export class UpdateProductDto extends PartialType(CreateProductDto) {}

class PriceDto {
  @ApiProperty({ example: 6200 }) @Type(() => Number) @IsInt() @Min(100) @Max(10_000_000) pricePaise: number;
}

@ApiTags('vendor-products')
@ApiBearerAuth()
@Roles('VENDOR')
@Controller('vendor/products')
export class VendorProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.products.list(user.id);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.products.get(user.id, id);
  }

  @Post()
  @ResponseMessage('Product added')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProductDto) {
    return this.products.create(user.id, dto);
  }

  @Patch(':id')
  @ResponseMessage('Product updated')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    return this.products.update(user.id, id, dto);
  }

  @Patch(':id/price')
  @ResponseMessage('Price updated')
  price(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PriceDto) {
    return this.products.update(user.id, id, { pricePaise: dto.pricePaise });
  }

  @Patch(':id/availability')
  @ResponseMessage('Availability updated')
  availability(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VendorAvailabilityDto) {
    return this.products.update(user.id, id, { isAvailable: dto.isAvailable });
  }

  @Delete(':id')
  @ResponseMessage('Product deleted')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.products.remove(user.id, id);
  }
}

@Module({
  imports: [AuthModule, MediaModule],
  controllers: [VendorOnboardingController, VendorProfileController, CatalogController, VendorProductsController],
  providers: [VendorsService, ProductsService],
  exports: [VendorsService, ProductsService],
})
export class VendorsModule {}

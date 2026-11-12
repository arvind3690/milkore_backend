import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type OperatingHours = Record<Weekday, { open: string; close: string; closed: boolean }>;

export class VendorBusinessDto {
  @ApiPropertyOptional({ example: 'Suresh Yadav' })
  @IsOptional()
  @IsString()
  @Length(2, 80)
  ownerName?: string;

  @ApiPropertyOptional({ example: 'Yadav Dairy' })
  @IsOptional()
  @IsString()
  @Length(2, 100)
  businessName?: string;

  @ApiPropertyOptional({ example: 'Fresh cow and buffalo milk, morning and evening.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    example: { mon: { open: '06:00', close: '20:00', closed: false } },
    description: 'All 7 days: mon..sun → { open "HH:mm", close "HH:mm", closed }',
  })
  @IsOptional()
  @IsObject()
  operatingHours?: OperatingHours;
}

export class VendorPhotosDto {
  @ApiProperty() @IsUUID() profilePhotoId: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID() shopPhotoId?: string | null;
}

export class VendorLocationDto {
  @ApiProperty({ example: 'Shop 12, Main Market' }) @IsString() @Length(3, 200) addressLine: string;
  @ApiProperty({ example: 'Baroda House' }) @IsString() @Length(2, 100) locality: string;
  @ApiProperty({ example: 'New Delhi' }) @IsString() @Length(2, 80) city: string;
  @ApiProperty({ example: 'Central Delhi' }) @IsString() @Length(2, 80) district: string;
  @ApiProperty({ example: 'Delhi' }) @IsString() @Length(2, 80) state: string;

  @ApiProperty({ example: '110001' })
  @IsString()
  @Matches(/^[1-9]\d{5}$/, { message: 'PIN code must be 6 digits' })
  pincode: string;

  @ApiProperty({ example: 28.6315 }) @Type(() => Number) @IsNumber() lat: number;
  @ApiProperty({ example: 77.2167 }) @Type(() => Number) @IsNumber() lng: number;
}

export class VendorServiceAreasDto {
  @ApiPropertyOptional({ example: 3000, description: '500–20000 metres from the shop' })
  @IsOptional()
  @IsInt()
  @Min(500)
  @Max(20000)
  radiusMeters?: number | null;

  @ApiPropertyOptional({ example: ['110001', '110002'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @Matches(/^[1-9]\d{5}$/, { each: true, message: 'Each PIN code must be 6 digits' })
  pincodes?: string[];

  @ApiPropertyOptional({ example: ['Connaught Place'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @Length(2, 100, { each: true })
  localities?: string[];
}

export class VendorAvailabilityDto {
  @ApiProperty() @IsBoolean() isAvailable: boolean;
}

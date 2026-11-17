import { BadRequestException, Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { DevicePlatform, NotificationTarget, UserRole, VendorApprovalStatus } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { Request } from 'express';
import { AuthAdmin, AuthUser, clientIp, CurrentAdmin, CurrentUser } from '../../common/auth/auth.types';
import { AdminRoute } from '../../common/auth/guards';
import { ResponseMessage } from '../../common/decorators';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { AppConfig } from '../../config/app-config.service';
import { Audience } from './audience';
import { CampaignsService } from './campaigns.service';
import { NotificationSender } from './notification-sender';
import { NotificationsService } from './notifications.service';
import { PushNotificationSender } from './push-notification-sender';
import { ConsolePushProvider, FcmPushProvider, PushProvider } from './push.provider';

// ─────────────────────────────── DTOs ───────────────────────────────

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

class RegisterDeviceDto {
  @ApiProperty({ description: 'FCM registration token' }) @IsString() @Length(20, 512) token: string;
  @ApiProperty({ enum: DevicePlatform }) @IsEnum(DevicePlatform) platform: DevicePlatform;
  @ApiPropertyOptional({ description: 'Stable per-install id (same as the login deviceId)' }) @IsOptional() @IsString() @MaxLength(128) deviceId?: string;
  @ApiPropertyOptional({ example: '1.2.0+14' }) @IsOptional() @IsString() @MaxLength(32) appVersion?: string;
}

class UnregisterDeviceDto {
  @ApiProperty() @IsString() @Length(20, 512) token: string;
}

class InboxQuery extends PaginationQueryDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  unreadOnly?: boolean;
}

/** Validate the raw JSON value: the global implicit conversion would turn "nope" into true. */
const raw = ({ obj, key }: { obj: Record<string, unknown>; key: string }) => obj[key];

class PreferencesDto {
  @ApiPropertyOptional({ description: 'New chat messages' }) @IsOptional() @Transform(raw) @IsBoolean() chat?: boolean;
  @ApiPropertyOptional({ description: 'Shop status, product and support updates' }) @IsOptional() @Transform(raw) @IsBoolean() account?: boolean;
  @ApiPropertyOptional({ description: 'News and offers from Milkore' }) @IsOptional() @Transform(raw) @IsBoolean() announcements?: boolean;
}

class AudienceDto {
  @ApiProperty({ enum: ['ALL', 'ROLE', 'USERS', 'LOCATION', 'VENDOR_STATUS'] })
  @IsIn(['ALL', 'ROLE', 'USERS', 'LOCATION', 'VENDOR_STATUS'])
  type: Audience['type'];

  @ApiPropertyOptional({ enum: UserRole, description: 'Required for ROLE; optional filter for LOCATION' })
  @ValidateIf((o: AudienceDto) => o.type === 'ROLE' || o.role !== undefined)
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional({ type: [String], description: 'USERS: 1–1000 user ids' })
  @ValidateIf((o: AudienceDto) => o.type === 'USERS')
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID('4', { each: true })
  userIds?: string[];

  @ApiPropertyOptional({ description: 'LOCATION: city name (case-insensitive)' })
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) city?: string;

  @ApiPropertyOptional({ description: 'LOCATION: 6-digit PIN code' })
  @IsOptional() @Transform(trim) @Matches(/^\d{6}$/, { message: 'PIN code must be 6 digits' }) pincode?: string;

  @ApiPropertyOptional({ enum: VendorApprovalStatus, description: 'Required for VENDOR_STATUS' })
  @ValidateIf((o: AudienceDto) => o.type === 'VENDOR_STATUS')
  @IsEnum(VendorApprovalStatus)
  approvalStatus?: VendorApprovalStatus;
}

function toAudience(d: AudienceDto): Audience {
  switch (d.type) {
    case 'ALL':
      return { type: 'ALL' };
    case 'ROLE':
      return { type: 'ROLE', role: d.role! };
    case 'USERS':
      return { type: 'USERS', userIds: [...new Set(d.userIds ?? [])] };
    case 'LOCATION':
      return { type: 'LOCATION', ...(d.role ? { role: d.role } : {}), ...(d.city ? { city: d.city } : {}), ...(d.pincode ? { pincode: d.pincode } : {}) };
    case 'VENDOR_STATUS':
      return { type: 'VENDOR_STATUS', approvalStatus: d.approvalStatus! };
    default:
      throw new BadRequestException({ message: 'Unknown audience.', errors: { audience: ['Unknown audience type'] } });
  }
}

class AudiencePreviewDto {
  @ApiProperty({ type: AudienceDto }) @ValidateNested() @Type(() => AudienceDto) audience: AudienceDto;
}

class TargetParamsDto {
  @ApiPropertyOptional({ description: 'VENDOR_DETAILS: the vendor to open' }) @IsOptional() @IsUUID() vendorId?: string;
}

class CreateCampaignDto {
  @ApiProperty({ example: 'Fresh paneer this Sunday' }) @Transform(trim) @IsString() @Length(3, 65) titleEn: string;
  @ApiProperty({ example: 'Order from dairies near you before 9 am.' }) @Transform(trim) @IsString() @Length(3, 240) bodyEn: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(2, 65) titleHi?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(2, 240) bodyHi?: string;
  @ApiProperty({ type: AudienceDto }) @ValidateNested() @Type(() => AudienceDto) audience: AudienceDto;
  @ApiPropertyOptional({ enum: NotificationTarget, default: 'NOTIFICATIONS' }) @IsOptional() @IsEnum(NotificationTarget) target: NotificationTarget = 'NOTIFICATIONS';
  @ApiPropertyOptional({ type: TargetParamsDto }) @IsOptional() @ValidateNested() @Type(() => TargetParamsDto) targetParams?: TargetParamsDto;
}

// ─────────────────────────────── controllers ───────────────────────────────

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('me')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('devices')
  @HttpCode(200)
  @ResponseMessage('Device registered')
  register(@CurrentUser() user: AuthUser, @Body() dto: RegisterDeviceDto) {
    return this.notifications.registerDevice(user.id, dto);
  }

  @Post('devices/unregister')
  @HttpCode(200)
  @ResponseMessage('Device removed')
  unregister(@CurrentUser() user: AuthUser, @Body() dto: UnregisterDeviceDto) {
    return this.notifications.unregisterDevice(user.id, dto.token);
  }

  @Get('notifications')
  list(@CurrentUser() user: AuthUser, @Query() q: InboxQuery) {
    return this.notifications.list(user.id, q);
  }

  @Get('notifications/unread-count')
  async unread(@CurrentUser() user: AuthUser) {
    return { unreadCount: await this.notifications.unreadCount(user.id) };
  }

  @Post('notifications/read-all')
  @HttpCode(200)
  @ResponseMessage('All marked as read')
  readAll(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user.id);
  }

  @Post('notifications/:id/read')
  @HttpCode(200)
  read(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(user.id, id);
  }

  @Get('notification-preferences')
  preferences(@CurrentUser() user: AuthUser) {
    return this.notifications.preferences(user.id);
  }

  @Patch('notification-preferences')
  @ResponseMessage('Preferences saved')
  updatePreferences(@CurrentUser() user: AuthUser, @Body() dto: PreferencesDto) {
    return this.notifications.updatePreferences(user.id, dto);
  }
}

@ApiTags('admin-notifications')
@AdminRoute()
@Controller('admin/notifications')
export class AdminNotificationsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Post('audience-preview')
  @HttpCode(200)
  preview(@Body() dto: AudiencePreviewDto) {
    return this.campaigns.preview(toAudience(dto.audience));
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('campaigns')
  @ResponseMessage('Sending started')
  create(@CurrentAdmin() admin: AuthAdmin, @Body() dto: CreateCampaignDto, @Req() req: Request) {
    return this.campaigns.create(
      admin,
      {
        titleEn: dto.titleEn,
        bodyEn: dto.bodyEn,
        titleHi: dto.titleHi,
        bodyHi: dto.bodyHi,
        audience: toAudience(dto.audience),
        target: dto.target,
        targetParams: dto.targetParams?.vendorId ? { vendorId: dto.targetParams.vendorId } : undefined,
      },
      clientIp(req),
    );
  }

  @Get('campaigns')
  list(@Query() q: PaginationQueryDto) {
    return this.campaigns.list(q);
  }

  @Get('campaigns/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.get(id);
  }
}

@Module({
  controllers: [NotificationsController, AdminNotificationsController],
  providers: [
    NotificationsService,
    CampaignsService,
    {
      provide: PushProvider,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => (config.get('PUSH_PROVIDER') === 'fcm' ? new FcmPushProvider(config) : new ConsolePushProvider()),
    },
    { provide: NotificationSender, useClass: PushNotificationSender },
  ],
  exports: [NotificationsService, NotificationSender],
})
export class NotificationsModule {}

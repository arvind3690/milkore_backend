import { Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { ReportStatus, TicketStatus, VendorApprovalStatus } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsEmail, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { AuthAdmin, clientIp, CurrentAdmin } from '../../common/auth/auth.types';
import { AdminRoute } from '../../common/auth/guards';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { Public, ResponseMessage } from '../../common/decorators';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { VendorsModule } from '../vendors/vendors.module';
import { AdminAuthService } from './admin-auth.service';
import { AdminService } from './admin.service';

// ─────────────────────────────── DTOs ───────────────────────────────

class AdminLoginDto {
  @ApiProperty() @IsEmail() email: string;
  @ApiProperty() @IsString() @Length(8, 128) password: string;
  @ApiPropertyOptional({ description: '6-digit authenticator code when TOTP is enabled' })
  @IsOptional()
  @Matches(/^\d{6}$/)
  totp?: string;
}

class AdminRefreshDto {
  @ApiProperty() @IsString() @MaxLength(200) refresh_token: string;
}

class AdminLogoutDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) refresh_token?: string;
}

class CreateAdminDto {
  @ApiProperty() @IsEmail() email: string;
  @ApiProperty() @IsString() @Length(2, 80) name: string;
  @ApiProperty() @IsString() @Length(10, 128) password: string;
  @ApiProperty({ enum: ['SUPER_ADMIN', 'MODERATOR'] }) @IsIn(['SUPER_ADMIN', 'MODERATOR']) role: 'SUPER_ADMIN' | 'MODERATOR';
}

class AdminStatusDto {
  @ApiProperty({ enum: ['ACTIVE', 'DISABLED'] }) @IsIn(['ACTIVE', 'DISABLED']) status: 'ACTIVE' | 'DISABLED';
}

class VendorListQuery extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: VendorApprovalStatus }) @IsOptional() @IsEnum(VendorApprovalStatus) status?: VendorApprovalStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) search?: string;
}

class ReasonDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

class UserListQuery extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['CUSTOMER', 'VENDOR'] }) @IsOptional() @IsIn(['CUSTOMER', 'VENDOR']) role?: 'CUSTOMER' | 'VENDOR';
  @ApiPropertyOptional({ enum: ['ACTIVE', 'SUSPENDED', 'DELETED'] }) @IsOptional() @IsIn(['ACTIVE', 'SUSPENDED', 'DELETED']) status?: 'ACTIVE' | 'SUSPENDED' | 'DELETED';
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) search?: string;
}

class UserStatusDto extends ReasonDto {
  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED'] }) @IsIn(['ACTIVE', 'SUSPENDED']) status: 'ACTIVE' | 'SUSPENDED';
}

class CreateCategoryDto {
  @ApiProperty({ example: 'lassi' }) @IsString() @Matches(/^[a-z0-9-]{2,40}$/) slug: string;
  @ApiProperty() @IsString() @Length(2, 60) nameEn: string;
  @ApiProperty() @IsString() @Length(1, 60) nameHi: string;
  @ApiProperty({ example: 'milk' }) @IsString() @Length(2, 40) iconKey: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(999) sortOrder?: number;
}

class UpdateCategoryDto extends PartialType(CreateCategoryDto) {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

class ProductListQuery extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) search?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() vendorId?: string;
  @ApiPropertyOptional({ enum: ['ACTIVE', 'REMOVED_BY_ADMIN'] }) @IsOptional() @IsIn(['ACTIVE', 'REMOVED_BY_ADMIN']) status?: 'ACTIVE' | 'REMOVED_BY_ADMIN';
}

class ReportListQuery extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ReportStatus }) @IsOptional() @IsEnum(ReportStatus) status?: ReportStatus;
}

class ResolveReportDto {
  @ApiProperty({ enum: ReportStatus }) @IsEnum(ReportStatus) status: ReportStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) note?: string;
}

class TicketListQuery extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: TicketStatus }) @IsOptional() @IsEnum(TicketStatus) status?: TicketStatus;
}

class UpdateTicketDto {
  @ApiPropertyOptional({ enum: TicketStatus }) @IsOptional() @IsEnum(TicketStatus) status?: TicketStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) adminNote?: string;
}

class AuditQuery extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) entityType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) entityId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() actorId?: string;
}

// ─────────────────────────────── controllers ───────────────────────────────

@ApiTags('admin-auth')
@AdminRoute()
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  @ResponseMessage('Logged in')
  login(@Body() dto: AdminLoginDto, @Req() req: Request) {
    return this.auth.login(dto.email, dto.password, dto.totp, clientIp(req));
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: AdminRefreshDto) {
    return this.auth.refresh(dto.refresh_token);
  }

  @Post('logout')
  @HttpCode(200)
  @ResponseMessage('Logged out')
  logout(@CurrentAdmin() admin: AuthAdmin, @Body() dto: AdminLogoutDto) {
    return this.auth.logout(admin.id, dto.refresh_token);
  }

  @Get('me')
  me(@CurrentAdmin() admin: AuthAdmin) {
    return this.auth.me(admin.id);
  }
}

@ApiTags('admin')
@AdminRoute()
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly auth: AdminAuthService,
  ) {}

  @Get('stats')
  stats() {
    return this.admin.stats();
  }

  // vendors
  @Get('vendors')
  vendors(@Query() q: VendorListQuery) {
    return this.admin.listVendors(q);
  }

  @Get('vendors/:id')
  vendor(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.vendorDetail(id);
  }

  @Post('vendors/:id/approve')
  @HttpCode(200)
  @ResponseMessage('Vendor approved')
  approve(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.admin.transitionVendor(a.id, id, 'APPROVED', null, clientIp(req));
  }

  @Post('vendors/:id/reject')
  @HttpCode(200)
  @ResponseMessage('Vendor rejected')
  reject(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Req() req: Request) {
    return this.admin.transitionVendor(a.id, id, 'REJECTED', dto.reason ?? null, clientIp(req));
  }

  @Post('vendors/:id/suspend')
  @HttpCode(200)
  @ResponseMessage('Vendor suspended')
  suspend(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Req() req: Request) {
    return this.admin.transitionVendor(a.id, id, 'SUSPENDED', dto.reason ?? null, clientIp(req));
  }

  @Post('vendors/:id/reactivate')
  @HttpCode(200)
  @ResponseMessage('Vendor reactivated')
  reactivate(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.admin.transitionVendor(a.id, id, 'APPROVED', null, clientIp(req));
  }

  // users
  @Get('users')
  users(@Query() q: UserListQuery) {
    return this.admin.listUsers(q);
  }

  @Get('customers')
  customers(@Query() q: UserListQuery) {
    return this.admin.listUsers({ ...q, role: 'CUSTOMER' });
  }

  @Patch('users/:id/status')
  @ResponseMessage('User updated')
  userStatus(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UserStatusDto, @Req() req: Request) {
    return this.admin.setUserStatus(a.id, id, dto.status, dto.reason, clientIp(req));
  }

  // catalogue (super admin only for changes)
  @Get('categories')
  categories() {
    return this.admin.listCategories();
  }

  @AdminRoute('SUPER_ADMIN')
  @Post('categories')
  @ResponseMessage('Category created')
  createCategory(@CurrentAdmin() a: AuthAdmin, @Body() dto: CreateCategoryDto, @Req() req: Request) {
    return this.admin.createCategory(a.id, dto, clientIp(req));
  }

  @AdminRoute('SUPER_ADMIN')
  @Patch('categories/:id')
  @ResponseMessage('Category updated')
  updateCategory(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto, @Req() req: Request) {
    const { slug: _slug, ...data } = dto;
    return this.admin.updateCategory(a.id, id, data, clientIp(req));
  }

  @Get('products')
  products(@Query() q: ProductListQuery) {
    return this.admin.listProducts(q);
  }

  @Post('products/:id/remove')
  @HttpCode(200)
  @ResponseMessage('Product removed')
  removeProduct(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Req() req: Request) {
    return this.admin.moderateProduct(a.id, id, true, dto.reason, clientIp(req));
  }

  @Post('products/:id/restore')
  @HttpCode(200)
  @ResponseMessage('Product restored')
  restoreProduct(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.admin.moderateProduct(a.id, id, false, undefined, clientIp(req));
  }

  // trust & safety
  @Get('reports')
  reports(@Query() q: ReportListQuery) {
    return this.admin.listReports(q);
  }

  @Patch('reports/:id')
  @ResponseMessage('Report updated')
  resolveReport(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveReportDto, @Req() req: Request) {
    return this.admin.resolveReport(a.id, id, dto.status, dto.note, clientIp(req));
  }

  @Get('support-tickets')
  tickets(@Query() q: TicketListQuery) {
    return this.admin.listTickets(q);
  }

  @Patch('support-tickets/:id')
  @ResponseMessage('Ticket updated')
  updateTicket(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTicketDto, @Req() req: Request) {
    return this.admin.updateTicket(a.id, id, dto, clientIp(req));
  }

  @Get('audit-logs')
  audit(@Query() q: AuditQuery) {
    return this.admin.auditLogs(q);
  }

  // admin accounts (super admin only)
  @AdminRoute('SUPER_ADMIN')
  @Get('admins')
  admins() {
    return this.auth.listAdmins();
  }

  @AdminRoute('SUPER_ADMIN')
  @Post('admins')
  @ResponseMessage('Admin created')
  createAdmin(@CurrentAdmin() a: AuthAdmin, @Body() dto: CreateAdminDto, @Req() req: Request) {
    return this.auth.createAdmin(a.id, dto, clientIp(req));
  }

  @AdminRoute('SUPER_ADMIN')
  @Patch('admins/:id/status')
  @ResponseMessage('Admin updated')
  adminStatus(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminStatusDto, @Req() req: Request) {
    return this.auth.setAdminStatus(a.id, id, dto.status, clientIp(req));
  }
}

@Module({
  imports: [AuthModule, VendorsModule, ChatModule, NotificationsModule],
  controllers: [AdminAuthController, AdminController],
  providers: [AdminService, AdminAuthService],
})
export class AdminModule {}

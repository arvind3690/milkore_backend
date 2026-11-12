import { BadRequestException, Body, Controller, Get, HttpException, HttpStatus, Injectable, Module, NotFoundException, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ReportReason, ReportTarget } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import { AuthUser, CurrentUser } from '../../common/auth/auth.types';
import { paginated, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { ResponseMessage } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';

export class CreateReportDto {
  @ApiProperty({ enum: ReportTarget }) @IsEnum(ReportTarget) targetType: ReportTarget;
  @ApiProperty() @IsUUID() targetId: string;
  @ApiProperty({ enum: ReportReason }) @IsEnum(ReportReason) reason: ReportReason;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) details?: string;
}

export class CreateTicketDto {
  @ApiProperty({ example: 'Cannot upload shop photo' }) @IsString() @Length(3, 120) subject: string;
  @ApiProperty() @IsString() @Length(5, 2000) message: string;
}

@Injectable()
export class TrustService {
  constructor(private readonly prisma: PrismaService) {}

  private async targetExists(type: ReportTarget, id: string): Promise<boolean> {
    switch (type) {
      case 'VENDOR':
        return Boolean(await this.prisma.vendorProfile.findUnique({ where: { id }, select: { id: true } }));
      case 'PRODUCT':
        return Boolean(await this.prisma.vendorProduct.findUnique({ where: { id }, select: { id: true } }));
      case 'USER':
        return Boolean(await this.prisma.user.findUnique({ where: { id }, select: { id: true } }));
      case 'MESSAGE':
        return Boolean(await this.prisma.message.findUnique({ where: { id }, select: { id: true } }));
    }
  }

  async report(userId: string, dto: CreateReportDto) {
    if (!(await this.targetExists(dto.targetType, dto.targetId))) throw new NotFoundException('We could not find what you reported.');
    if (dto.targetType === 'USER' && dto.targetId === userId) throw new BadRequestException('You cannot report yourself.');
    const today = await this.prisma.report.count({
      where: { reporterUserId: userId, createdAt: { gte: new Date(Date.now() - 86_400_000) } },
    });
    if (today >= 10) throw new HttpException('You have sent many reports today. Please try tomorrow.', HttpStatus.TOO_MANY_REQUESTS);
    const open = await this.prisma.report.findFirst({
      where: { reporterUserId: userId, targetType: dto.targetType, targetId: dto.targetId, status: 'OPEN' },
    });
    if (open) return { id: open.id, status: open.status };
    const report = await this.prisma.report.create({
      data: { reporterUserId: userId, targetType: dto.targetType, targetId: dto.targetId, reason: dto.reason, details: dto.details?.trim() || null },
    });
    return { id: report.id, status: report.status };
  }

  async createTicket(userId: string, dto: CreateTicketDto) {
    const open = await this.prisma.supportTicket.count({ where: { userId, status: { not: 'CLOSED' } } });
    if (open >= 5) throw new HttpException('You already have 5 open requests. We will reply soon.', HttpStatus.TOO_MANY_REQUESTS);
    return this.prisma.supportTicket.create({
      data: { userId, subject: dto.subject.trim(), message: dto.message.trim() },
      select: { id: true, subject: true, message: true, status: true, adminNote: true, createdAt: true, updatedAt: true },
    });
  }

  async myTickets(userId: string, page: number, limit: number) {
    const where = { userId };
    const [total, items] = await Promise.all([
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: { id: true, subject: true, message: true, status: true, adminNote: true, createdAt: true, updatedAt: true },
      }),
    ]);
    return paginated(items, total, { page, limit });
  }
}

@ApiTags('reports-support')
@ApiBearerAuth()
@Controller()
export class TrustController {
  constructor(private readonly trust: TrustService) {}

  @Post('reports')
  @ResponseMessage('Thank you. Our team will review this.')
  report(@CurrentUser() user: AuthUser, @Body() dto: CreateReportDto) {
    return this.trust.report(user.id, dto);
  }

  @Post('support/tickets')
  @ResponseMessage('Request sent. We will get back to you soon.')
  ticket(@CurrentUser() user: AuthUser, @Body() dto: CreateTicketDto) {
    return this.trust.createTicket(user.id, dto);
  }

  @Get('support/tickets')
  tickets(@CurrentUser() user: AuthUser, @Query() q: PaginationQueryDto) {
    return this.trust.myTickets(user.id, q.page, q.limit);
  }
}

@Module({ controllers: [TrustController], providers: [TrustService] })
export class TrustModule {}

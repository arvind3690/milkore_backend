import { randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { NotificationCampaign, NotificationTarget, Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { AuthAdmin } from '../../common/auth/auth.types';
import { paginated } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { Audience, audienceWhere, CAMPAIGN_TARGETS, describeAudience, isBroadcast, isVendorOnly, VENDOR_ONLY_TARGETS } from './audience';
import { allowsPush, CHANNEL_OF, NotificationsService, pushData, TargetParams } from './notifications.service';
import { PushEnvelope } from './push.provider';

export interface CampaignInput {
  titleEn: string;
  bodyEn: string;
  titleHi?: string;
  bodyHi?: string;
  audience: Audience;
  target: NotificationTarget;
  targetParams?: TargetParams;
}

const BATCH = 500;
/** A SENDING campaign older than this at startup was cut off by a restart. */
const STALE_MS = 10 * 60_000;

/**
 * Admin campaigns ("send now"). Every recipient gets an inbox entry; devices of users who
 * allow announcements get a push. Runs in-process in batches (no queue, per CLAUDE.md).
 */
@Injectable()
export class CampaignsService implements OnModuleInit {
  private readonly logger = new Logger('Campaigns');
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit() {
    const { count } = await this.prisma.notificationCampaign.updateMany({
      where: { status: 'SENDING', createdAt: { lt: new Date(Date.now() - STALE_MS) } },
      data: { status: 'FAILED', errorMessage: 'Interrupted by a server restart. Check the counts and resend if needed.' },
    });
    if (count) this.logger.warn(`${count} interrupted campaign(s) marked FAILED`);
  }

  /** For tests and graceful shutdown: wait until background sends finish. */
  async drain() {
    await Promise.all([...this.running]);
  }

  private validate(input: CampaignInput) {
    const a = input.audience;
    if (a.type === 'LOCATION' && !a.city?.trim() && !a.pincode?.trim()) {
      throw new BadRequestException({ message: 'Choose a city or a PIN code.', errors: { audience: ['City or PIN code is required'] } });
    }
    if (a.type === 'USERS' && a.userIds.length === 0) {
      throw new BadRequestException({ message: 'Choose at least one user.', errors: { audience: ['Select at least one user'] } });
    }
    if (!CAMPAIGN_TARGETS.includes(input.target)) {
      throw new BadRequestException({ message: 'This screen cannot be used for a campaign.', errors: { target: ['Not allowed for campaigns'] } });
    }
    if (VENDOR_ONLY_TARGETS.includes(input.target) && !isVendorOnly(a)) {
      throw new BadRequestException({
        message: 'Vendor screens can only be sent to a vendor-only audience.',
        errors: { target: ['Pick a vendor audience or a different screen'] },
      });
    }
    if (input.target === 'VENDOR_DETAILS' && !input.targetParams?.vendorId) {
      throw new BadRequestException({ message: 'Choose the vendor to open.', errors: { targetParams: ['vendorId is required'] } });
    }
    if ((input.titleHi && !input.bodyHi) || (!input.titleHi && input.bodyHi)) {
      throw new BadRequestException({ message: 'Give both the Hindi title and text, or neither.', errors: { titleHi: ['Hindi title and text go together'] } });
    }
  }

  private async cleanParams(input: CampaignInput): Promise<TargetParams | undefined> {
    if (input.target === 'VENDOR_DETAILS') {
      const vendorId = input.targetParams!.vendorId!;
      const ok = await this.prisma.vendorProfile.findFirst({ where: { id: vendorId, approvalStatus: 'APPROVED', deletedAt: null }, select: { id: true } });
      if (!ok) throw new BadRequestException({ message: 'That vendor is not live.', errors: { targetParams: ['Vendor must be approved'] } });
      return { vendorId };
    }
    return undefined; // other targets take no parameters
  }

  /** How many users match, and how many of them will actually get a push. */
  async preview(audience: Audience) {
    const where = audienceWhere(audience);
    const [recipients, reachable] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.count({
        where: {
          AND: [where, { deviceTokens: { some: {} } }, { OR: [{ notificationPreference: null }, { notificationPreference: { announcements: true } }] }],
        },
      }),
    ]);
    return { recipients, reachable, label: describeAudience(audience) };
  }

  async create(admin: AuthAdmin, input: CampaignInput, ip: string) {
    if (isBroadcast(input.audience) && admin.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Only a super admin can send to all users or a whole role.');
    }
    this.validate(input);
    const targetParams = await this.cleanParams(input);
    const recipients = await this.prisma.user.count({ where: audienceWhere(input.audience) });
    if (recipients === 0) {
      throw new BadRequestException({ message: 'No users match this audience.', errors: { audience: ['No matching users'] } });
    }
    const campaign = await this.prisma.notificationCampaign.create({
      data: {
        createdByAdminId: admin.id,
        titleEn: input.titleEn.trim(),
        bodyEn: input.bodyEn.trim(),
        titleHi: input.titleHi?.trim() || null,
        bodyHi: input.bodyHi?.trim() || null,
        audience: input.audience as unknown as Prisma.InputJsonValue,
        target: input.target,
        targetParams: targetParams ?? undefined,
        recipientCount: recipients,
      },
    });
    await this.audit.record({
      actorType: 'ADMIN',
      actorId: admin.id,
      action: 'notification.campaign',
      entityType: 'notification_campaign',
      entityId: campaign.id,
      metadata: { audience: describeAudience(input.audience), recipients, target: input.target },
      ip,
    });
    const job = this.run(campaign).finally(() => this.running.delete(job));
    this.running.add(job);
    return this.toDto(campaign);
  }

  private async run(c: NotificationCampaign) {
    const where = audienceWhere(c.audience as unknown as Audience);
    const params = (c.targetParams as TargetParams | null) ?? undefined;
    let cursor: string | undefined;
    let delivered = 0;
    let failed = 0;
    let noDevice = 0;
    let recipients = 0;
    try {
      for (;;) {
        const users = await this.prisma.user.findMany({
          where,
          orderBy: { id: 'asc' },
          take: BATCH,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          select: { id: true, preferredLanguage: true, notificationPreference: true, deviceTokens: { select: { token: true } } },
        });
        if (users.length === 0) break;
        cursor = users[users.length - 1]!.id;
        recipients += users.length;

        const rows = users.map((u) => {
          const hi = u.preferredLanguage === 'hi' && !!c.titleHi && !!c.bodyHi;
          return { id: randomUUID(), userId: u.id, title: hi ? c.titleHi! : c.titleEn, body: hi ? c.bodyHi! : c.bodyEn };
        });
        await this.prisma.notification.createMany({
          data: rows.map((r) => ({
            id: r.id, userId: r.userId, category: 'ANNOUNCEMENT', type: 'CAMPAIGN', title: r.title, body: r.body,
            target: c.target, targetParams: params, campaignId: c.id,
          })),
        });

        const messages: PushEnvelope[] = [];
        users.forEach((u, i) => {
          if (!allowsPush(u.notificationPreference, 'ANNOUNCEMENT') || u.deviceTokens.length === 0) {
            noDevice++;
            return;
          }
          const row = rows[i]!;
          const data = pushData({ notificationId: row.id, campaignId: c.id, type: 'CAMPAIGN', category: 'ANNOUNCEMENT', target: c.target, targetParams: params });
          for (const t of u.deviceTokens) messages.push({ token: t.token, title: row.title, body: row.body, data, channel: CHANNEL_OF.ANNOUNCEMENT });
        });
        const res = await this.notifications.deliver(messages);
        delivered += res.delivered;
        failed += res.failed;
        await this.prisma.notificationCampaign.update({
          where: { id: c.id },
          data: { recipientCount: recipients, deliveredCount: delivered, failedCount: failed, noDeviceCount: noDevice },
        });
        if (users.length < BATCH) break;
      }
      await this.prisma.notificationCampaign.update({
        where: { id: c.id },
        data: { status: 'SENT', sentAt: new Date(), recipientCount: recipients, deliveredCount: delivered, failedCount: failed, noDeviceCount: noDevice },
      });
    } catch (err) {
      this.logger.error(`Campaign ${c.id} failed: ${(err as Error).message}`);
      await this.prisma.notificationCampaign
        .update({ where: { id: c.id }, data: { status: 'FAILED', errorMessage: 'Sending stopped because of a server error.', sentAt: new Date() } })
        .catch(() => undefined);
    }
  }

  private async admins(ids: string[]) {
    const rows = await this.prisma.adminUser.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } });
    return new Map(rows.map((a) => [a.id, a]));
  }

  private toDto(c: NotificationCampaign, admin?: { id: string; name: string; email: string } | null) {
    return {
      id: c.id,
      titleEn: c.titleEn,
      bodyEn: c.bodyEn,
      titleHi: c.titleHi,
      bodyHi: c.bodyHi,
      audience: c.audience,
      audienceLabel: describeAudience(c.audience as unknown as Audience),
      target: c.target,
      targetParams: c.targetParams ?? {},
      status: c.status,
      recipientCount: c.recipientCount,
      deliveredCount: c.deliveredCount,
      failedCount: c.failedCount,
      noDeviceCount: c.noDeviceCount,
      errorMessage: c.errorMessage,
      sentAt: c.sentAt,
      createdAt: c.createdAt,
      createdBy: admin ?? null,
    };
  }

  async list(q: { page: number; limit: number }) {
    const [total, rows] = await Promise.all([
      this.prisma.notificationCampaign.count(),
      this.prisma.notificationCampaign.findMany({ orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    const admins = await this.admins(rows.map((r) => r.createdByAdminId));
    return paginated(rows.map((r) => this.toDto(r, admins.get(r.createdByAdminId))), total, q);
  }

  async get(id: string) {
    const c = await this.prisma.notificationCampaign.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Campaign not found.');
    const [admins, read] = await Promise.all([
      this.admins([c.createdByAdminId]),
      this.prisma.notification.count({ where: { campaignId: id, readAt: { not: null } } }),
    ]);
    return { ...this.toDto(c, admins.get(c.createdByAdminId)), readCount: read };
  }
}

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DevicePlatform, Notification, NotificationCategory, NotificationTarget, NotificationType } from '@prisma/client';
import { paginated } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { Lang, renderTemplate, TemplateInput } from './notification-templates';
import { PushChannel, PushEnvelope, PushProvider, PushResult } from './push.provider';

export type TargetParams = Record<string, string>;

export interface Preferences {
  chat: boolean;
  account: boolean;
  announcements: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = { chat: true, account: true, announcements: true };

export const CHANNEL_OF: Record<NotificationCategory, PushChannel> = {
  CHAT: 'chat',
  ACCOUNT: 'account',
  ANNOUNCEMENT: 'announcements',
};

export function allowsPush(prefs: Preferences | null | undefined, category: NotificationCategory): boolean {
  const p = prefs ?? DEFAULT_PREFERENCES;
  return category === 'CHAT' ? p.chat : category === 'ACCOUNT' ? p.account : p.announcements;
}

/** The FCM `data` payload the app routes on. Every value is a string. */
export function pushData(input: {
  notificationId?: string;
  campaignId?: string;
  type: NotificationType;
  category: NotificationCategory;
  target: NotificationTarget;
  targetParams?: TargetParams | null;
}): Record<string, string> {
  return {
    ...(input.targetParams ?? {}),
    ...(input.notificationId ? { notificationId: input.notificationId } : {}),
    ...(input.campaignId ? { campaignId: input.campaignId } : {}),
    type: input.type,
    category: input.category,
    target: input.target,
  };
}

export interface NotifyInput {
  category: NotificationCategory;
  target: NotificationTarget;
  targetParams?: TargetParams;
  template: TemplateInput;
  collapseKey?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('Notifications');

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushProvider,
  ) {}

  // ─────────────────────────────── devices ───────────────────────────────

  /** Idempotent. A token already registered to someone else moves to this user (shared phone, re-login). */
  async registerDevice(userId: string, d: { token: string; platform: DevicePlatform; deviceId?: string; appVersion?: string }) {
    await this.prisma.$transaction([
      // The same install got a new token: drop the old one so we don't push twice.
      ...(d.deviceId ? [this.prisma.deviceToken.deleteMany({ where: { userId, deviceId: d.deviceId, token: { not: d.token } } })] : []),
      this.prisma.deviceToken.upsert({
        where: { token: d.token },
        update: { userId, platform: d.platform, deviceId: d.deviceId ?? null, appVersion: d.appVersion ?? null, lastSeenAt: new Date() },
        create: { userId, token: d.token, platform: d.platform, deviceId: d.deviceId ?? null, appVersion: d.appVersion ?? null },
      }),
    ]);
    return null;
  }

  async unregisterDevice(userId: string, token: string) {
    await this.prisma.deviceToken.deleteMany({ where: { userId, token } });
    return null;
  }

  async removeAllDevices(userId: string) {
    await this.prisma.deviceToken.deleteMany({ where: { userId } });
  }

  // ─────────────────────────────── preferences ───────────────────────────────

  async preferences(userId: string): Promise<Preferences> {
    const p = await this.prisma.notificationPreference.findUnique({ where: { userId } });
    return p ? { chat: p.chat, account: p.account, announcements: p.announcements } : { ...DEFAULT_PREFERENCES };
  }

  async updatePreferences(userId: string, data: Partial<Preferences>): Promise<Preferences> {
    const p = await this.prisma.notificationPreference.upsert({
      where: { userId },
      update: data,
      create: { userId, ...DEFAULT_PREFERENCES, ...data },
    });
    return { chat: p.chat, account: p.account, announcements: p.announcements };
  }

  // ─────────────────────────────── inbox ───────────────────────────────

  toDto(n: Notification) {
    return {
      id: n.id,
      category: n.category,
      type: n.type,
      title: n.title,
      body: n.body,
      target: n.target,
      targetParams: (n.targetParams as TargetParams | null) ?? {},
      isRead: n.readAt !== null,
      readAt: n.readAt,
      createdAt: n.createdAt,
    };
  }

  async list(userId: string, q: { page: number; limit: number; unreadOnly?: boolean }) {
    const where = { userId, ...(q.unreadOnly ? { readAt: null } : {}) };
    const [total, rows, unread] = await Promise.all([
      this.prisma.notification.count({ where }),
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
      this.unreadCount(userId),
    ]);
    return { ...paginated(rows.map((n) => this.toDto(n)), total, q), unreadCount: unread };
  }

  unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  async markRead(userId: string, id: string) {
    const n = await this.prisma.notification.findFirst({ where: { id, userId } });
    if (!n) throw new NotFoundException('Notification not found.');
    const updated = n.readAt ? n : await this.prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
    return this.toDto(updated);
  }

  async markAllRead(userId: string) {
    const { count } = await this.prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
    return { updated: count };
  }

  // ─────────────────────────────── sending ───────────────────────────────

  /**
   * Sends one automatic notification to one user, in their language.
   * Non-chat notifications always land in the inbox; the push respects the user's preferences.
   * Never throws: a push problem must not fail the action that caused it.
   */
  async notifyUser(userId: string, input: NotifyInput): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { status: true, preferredLanguage: true, notificationPreference: true, deviceTokens: { select: { token: true } } },
      });
      if (!user || user.status !== 'ACTIVE') return;

      const { title, body } = renderTemplate(user.preferredLanguage as Lang, input.template);
      const type = input.template.type as NotificationType;
      let notificationId: string | undefined;
      if (input.category !== 'CHAT') {
        const row = await this.prisma.notification.create({
          data: { userId, category: input.category, type, title, body, target: input.target, targetParams: input.targetParams ?? undefined },
        });
        notificationId = row.id;
      }
      if (!allowsPush(user.notificationPreference, input.category) || user.deviceTokens.length === 0) return;

      const data = pushData({ notificationId, type, category: input.category, target: input.target, targetParams: input.targetParams });
      await this.deliver(
        user.deviceTokens.map((t) => ({ token: t.token, title, body, data, channel: CHANNEL_OF[input.category], collapseKey: input.collapseKey })),
      );
    } catch (err) {
      this.logger.error(`notifyUser failed (${input.template.type}): ${(err as Error).message}`);
    }
  }

  /** Sends and prunes dead tokens. */
  async deliver(messages: PushEnvelope[]): Promise<PushResult> {
    if (messages.length === 0) return { delivered: 0, failed: 0, invalidTokens: [] };
    const result = await this.push.send(messages);
    if (result.invalidTokens.length) {
      await this.prisma.deviceToken.deleteMany({ where: { token: { in: result.invalidTokens } } });
    }
    return result;
  }
}

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationSender } from './notification-sender';
import { NotificationsService } from './notifications.service';

/** The real NotificationSender: turns domain events into role-specific pushes + inbox entries. */
@Injectable()
export class PushNotificationSender extends NotificationSender {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  /** Customer → vendor shows the customer's name; vendor → customer shows the shop name. */
  async notifyNewMessage(recipientUserId: string, data: { conversationId: string; preview: string }) {
    const c = await this.prisma.conversation
      .findUnique({ where: { id: data.conversationId }, select: { customerId: true, vendorId: true } })
      .catch(() => null);
    if (!c) return;
    let senderName: string | null = null;
    if (c.customerId === recipientUserId) {
      senderName = (await this.prisma.vendorProfile.findUnique({ where: { id: c.vendorId }, select: { businessName: true } }))?.businessName ?? null;
    } else {
      senderName = (await this.prisma.user.findUnique({ where: { id: c.customerId }, select: { name: true } }))?.name ?? null;
    }
    await this.notifications.notifyUser(recipientUserId, {
      category: 'CHAT',
      target: 'CHAT',
      targetParams: { conversationId: data.conversationId },
      template: { type: 'CHAT_MESSAGE', senderName, preview: data.preview },
      collapseKey: `chat_${data.conversationId}`,
    });
  }

  async notifyVendorStatus(recipientUserId: string, data: { status: string; reason?: string | null }) {
    await this.notifications.notifyUser(recipientUserId, {
      category: 'ACCOUNT',
      target: 'VENDOR_DASHBOARD',
      template: { type: 'VENDOR_STATUS', status: data.status, reason: data.reason },
      collapseKey: 'vendor_status',
    });
  }

  async notifyProductModerated(recipientUserId: string, data: { productId: string; productName: string; removed: boolean; reason?: string | null }) {
    await this.notifications.notifyUser(recipientUserId, {
      category: 'ACCOUNT',
      target: 'VENDOR_PRODUCTS',
      targetParams: { productId: data.productId },
      template: { type: 'PRODUCT_MODERATED', productName: data.productName, removed: data.removed, reason: data.reason },
    });
  }

  async notifySupportUpdate(recipientUserId: string, data: { ticketId: string; subject: string; status: string; note?: string | null }) {
    await this.notifications.notifyUser(recipientUserId, {
      category: 'ACCOUNT',
      target: 'SUPPORT',
      targetParams: { ticketId: data.ticketId },
      template: { type: 'SUPPORT_UPDATE', subject: data.subject, status: data.status, note: data.note },
      collapseKey: `ticket_${data.ticketId}`,
    });
  }

  async notifyReportResolved(recipientUserId: string, data: { reportId: string; status: string }) {
    await this.notifications.notifyUser(recipientUserId, {
      category: 'ACCOUNT',
      target: 'NOTIFICATIONS',
      targetParams: { reportId: data.reportId },
      template: { type: 'REPORT_RESOLVED', status: data.status },
    });
  }
}

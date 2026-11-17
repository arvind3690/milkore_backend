import { Injectable } from '@nestjs/common';

/**
 * Domain-level outbound notifications. Feature services call these methods and never care
 * about FCM, templates or preferences. Implementations must never throw (a failed push must
 * not fail the business action that caused it).
 */
export abstract class NotificationSender {
  abstract notifyNewMessage(recipientUserId: string, data: { conversationId: string; preview: string }): Promise<void>;
  abstract notifyVendorStatus(recipientUserId: string, data: { status: string; reason?: string | null }): Promise<void>;
  abstract notifyProductModerated(
    recipientUserId: string,
    data: { productId: string; productName: string; removed: boolean; reason?: string | null },
  ): Promise<void>;
  abstract notifySupportUpdate(
    recipientUserId: string,
    data: { ticketId: string; subject: string; status: string; note?: string | null },
  ): Promise<void>;
  abstract notifyReportResolved(recipientUserId: string, data: { reportId: string; status: string }): Promise<void>;
}

/** Does nothing. Useful in unit tests that don't care about notifications. */
@Injectable()
export class NoopNotificationSender extends NotificationSender {
  async notifyNewMessage(): Promise<void> {}
  async notifyVendorStatus(): Promise<void> {}
  async notifyProductModerated(): Promise<void> {}
  async notifySupportUpdate(): Promise<void> {}
  async notifyReportResolved(): Promise<void> {}
}

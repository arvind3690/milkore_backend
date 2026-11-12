import { Injectable, Logger } from '@nestjs/common';
import { AccessSource, CommChannel } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface AccessDecision {
  allowed: boolean;
  source: AccessSource | null;
  /** Set when access is denied (future: "Pay ₹10 to chat"). */
  reason?: 'PAYMENT_REQUIRED';
  priceInPaise?: number;
}

/**
 * The single gate for customer → vendor communication (ADR-009, D4).
 * MVP: every request is granted as FREE_MVP and recorded. To launch paid access later,
 * change only this method (check for a PAID row / validUntil) — chat and calls stay untouched.
 */
@Injectable()
export class CommunicationPolicyService {
  private readonly logger = new Logger(CommunicationPolicyService.name);

  constructor(private readonly prisma: PrismaService) {}

  async canAccess(customerId: string, vendorId: string, channel: CommChannel): Promise<AccessDecision> {
    const existing = await this.prisma.communicationAccess.findUnique({
      where: { customerId_vendorId_channel: { customerId, vendorId, channel } },
    });
    if (existing && (!existing.validUntil || existing.validUntil > new Date())) {
      return { allowed: true, source: existing.source };
    }
    const granted = await this.prisma.communicationAccess.upsert({
      where: { customerId_vendorId_channel: { customerId, vendorId, channel } },
      update: { source: 'FREE_MVP', validUntil: null },
      create: { customerId, vendorId, channel, source: 'FREE_MVP' },
    });
    return { allowed: true, source: granted.source };
  }
}

/** Out-of-app delivery (push). No-op in the MVP (ADR-002); swap the provider to add FCM later. */
export abstract class NotificationSender {
  abstract notifyNewMessage(recipientUserId: string, data: { conversationId: string; preview: string }): Promise<void>;
  abstract notifyVendorStatus(recipientUserId: string, data: { status: string; reason?: string | null }): Promise<void>;
}

@Injectable()
export class NoopNotificationSender extends NotificationSender {
  async notifyNewMessage(): Promise<void> {}
  async notifyVendorStatus(): Promise<void> {}
}

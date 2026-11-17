import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Conversation, Message } from '@prisma/client';
import { paginated } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaService } from '../media/media.service';
import { ChatGateway } from './chat.gateway';
import { CommunicationPolicyService, NotificationSender } from './communication-policy.service';

type Side = 'CUSTOMER' | 'VENDOR';

interface Participation {
  conversation: Conversation;
  side: Side;
  customerUserId: string;
  vendorUserId: string;
}

export function cleanBody(raw: string): string {
  // Strip control characters (keep newlines/tabs), collapse runs of blank lines.
  // eslint-disable-next-line no-control-regex
  const body = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!body) throw new BadRequestException({ message: 'Message is empty.', errors: { body: ['Type a message'] } });
  if (body.length > 2000) throw new BadRequestException({ message: 'Message is too long.', errors: { body: ['Maximum 2000 characters'] } });
  return body;
}

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: CommunicationPolicyService,
    private readonly gateway: ChatGateway,
    private readonly notifier: NotificationSender,
    private readonly media: MediaService,
  ) {}

  private async myVendorId(userId: string): Promise<string | null> {
    const v = await this.prisma.vendorProfile.findUnique({ where: { userId }, select: { id: true } });
    return v?.id ?? null;
  }

  /** Loads a conversation the user participates in; anyone else gets 404. */
  private async participation(userId: string, conversationId: string): Promise<Participation> {
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) throw new NotFoundException('Chat not found.');
    const vendor = await this.prisma.vendorProfile.findUnique({ where: { id: conversation.vendorId }, select: { userId: true } });
    if (!vendor) throw new NotFoundException('Chat not found.');
    if (conversation.customerId === userId) {
      return { conversation, side: 'CUSTOMER', customerUserId: userId, vendorUserId: vendor.userId };
    }
    if (vendor.userId === userId) {
      return { conversation, side: 'VENDOR', customerUserId: conversation.customerId, vendorUserId: userId };
    }
    throw new NotFoundException('Chat not found.');
  }

  private messageDto(m: Message, myUserId: string) {
    return {
      id: m.id,
      conversationId: m.conversationId,
      senderUserId: m.senderUserId,
      isMine: m.senderUserId === myUserId,
      type: m.type,
      body: m.body,
      clientMessageId: m.clientMessageId,
      createdAt: m.createdAt,
      readAt: m.readAt,
    };
  }

  private async conversationDto(c: Conversation, side: Side) {
    if (side === 'CUSTOMER') {
      const vendor = await this.prisma.vendorProfile.findUnique({
        where: { id: c.vendorId },
        include: { profilePhoto: { select: { storageKey: true, status: true } } },
      });
      return {
        id: c.id,
        myRole: side,
        status: c.status,
        blockedByMe: c.blockedByUserId !== null && c.blockedByUserId === c.customerId,
        counterpart: {
          type: 'VENDOR' as const,
          vendorId: c.vendorId,
          name: vendor?.businessName ?? 'Seller',
          photoUrl: vendor?.profilePhoto?.status === 'READY' ? await this.media.url(vendor.profilePhoto.storageKey) : null,
        },
        lastMessageAt: c.lastMessageAt,
        lastMessagePreview: c.lastMessagePreview,
        unreadCount: c.customerUnread,
        createdAt: c.createdAt,
      };
    }
    const customer = await this.prisma.user.findUnique({ where: { id: c.customerId }, select: { name: true } });
    const vendor = await this.prisma.vendorProfile.findUnique({ where: { id: c.vendorId }, select: { userId: true } });
    return {
      id: c.id,
      myRole: side,
      status: c.status,
      blockedByMe: c.blockedByUserId !== null && c.blockedByUserId === vendor?.userId,
      // Customers' phone numbers and locations are never shared with vendors.
      counterpart: { type: 'CUSTOMER' as const, userId: c.customerId, name: customer?.name ?? 'Customer', photoUrl: null },
      lastMessageAt: c.lastMessageAt,
      lastMessagePreview: c.lastMessagePreview,
      unreadCount: c.vendorUnread,
      createdAt: c.createdAt,
    };
  }

  private async approvedVendor(vendorId: string) {
    const vendor = await this.prisma.vendorProfile.findFirst({
      where: { id: vendorId, approvalStatus: 'APPROVED', deletedAt: null, user: { status: 'ACTIVE' } },
    });
    if (!vendor) throw new NotFoundException('This seller is not available.');
    return vendor;
  }

  async start(userId: string, vendorId: string) {
    const vendor = await this.approvedVendor(vendorId);
    if (vendor.userId === userId) throw new BadRequestException('You cannot chat with your own shop.');
    const decision = await this.policy.canAccess(userId, vendor.id, 'CHAT');
    if (!decision.allowed) throw new ForbiddenException('Chat is not available for this seller.');
    const conversation = await this.prisma.conversation.upsert({
      where: { customerId_vendorId: { customerId: userId, vendorId: vendor.id } },
      update: {},
      create: { customerId: userId, vendorId: vendor.id },
    });
    return this.conversationDto(conversation, 'CUSTOMER');
  }

  async list(userId: string, page: number, limit: number) {
    const vendorId = await this.myVendorId(userId);
    const where = { OR: [{ customerId: userId }, ...(vendorId ? [{ vendorId }] : [])] };
    const [total, rows] = await Promise.all([
      this.prisma.conversation.count({ where }),
      this.prisma.conversation.findMany({
        where,
        orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    const items = await Promise.all(rows.map((c) => this.conversationDto(c, c.customerId === userId ? 'CUSTOMER' : 'VENDOR')));
    return paginated(items, total, { page, limit });
  }

  async get(userId: string, conversationId: string) {
    const p = await this.participation(userId, conversationId);
    return this.conversationDto(p.conversation, p.side);
  }

  /** Newest first. `before` is a message id; `nextCursor` is null when there is no older page. */
  async messages(userId: string, conversationId: string, before: string | undefined, limit: number) {
    await this.participation(userId, conversationId);
    let createdBefore: Date | undefined;
    if (before) {
      const anchor = await this.prisma.message.findFirst({ where: { id: before, conversationId } });
      if (!anchor) throw new BadRequestException('Invalid cursor.');
      createdBefore = anchor.createdAt;
    }
    const rows = await this.prisma.message.findMany({
      where: { conversationId, ...(createdBefore ? { createdAt: { lt: createdBefore } } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((m) => this.messageDto(m, userId));
    return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
  }

  async send(userId: string, conversationId: string, clientMessageId: string, rawBody: string) {
    const p = await this.participation(userId, conversationId);
    const existing = await this.prisma.message.findUnique({
      where: { senderUserId_clientMessageId: { senderUserId: userId, clientMessageId } },
    });
    if (existing) {
      if (existing.conversationId !== conversationId) throw new ConflictException('Duplicate message id.');
      return this.messageDto(existing, userId);
    }
    if (p.conversation.status === 'BLOCKED') throw new ForbiddenException('You cannot send messages in this chat.');
    const body = cleanBody(rawBody);
    if (p.side === 'CUSTOMER') {
      await this.approvedVendor(p.conversation.vendorId);
      const decision = await this.policy.canAccess(userId, p.conversation.vendorId, 'CHAT');
      if (!decision.allowed) throw new ForbiddenException('Chat is not available for this seller.');
    }

    const [message] = await this.prisma.$transaction([
      this.prisma.message.create({ data: { conversationId, senderUserId: userId, body, clientMessageId } }),
      this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          lastMessageAt: new Date(),
          lastMessagePreview: body.slice(0, 120),
          ...(p.side === 'CUSTOMER' ? { vendorUnread: { increment: 1 } } : { customerUnread: { increment: 1 } }),
        },
      }),
    ]);

    const recipient = p.side === 'CUSTOMER' ? p.vendorUserId : p.customerUserId;
    this.gateway.emitToUsers([recipient], 'message:new', { conversationId, message: this.messageDto(message, recipient) });
    this.gateway.emitToUsers([userId], 'message:new', { conversationId, message: this.messageDto(message, userId) });
    if (!this.gateway.isOnline(recipient)) {
      await this.notifier.notifyNewMessage(recipient, { conversationId, preview: body.slice(0, 80) });
    }
    return this.messageDto(message, userId);
  }

  async markRead(userId: string, conversationId: string) {
    const p = await this.participation(userId, conversationId);
    const readAt = new Date();
    await this.prisma.$transaction([
      this.prisma.message.updateMany({
        where: { conversationId, senderUserId: { not: userId }, readAt: null },
        data: { readAt },
      }),
      this.prisma.conversation.update({
        where: { id: conversationId },
        data: p.side === 'CUSTOMER' ? { customerUnread: 0 } : { vendorUnread: 0 },
      }),
    ]);
    const other = p.side === 'CUSTOMER' ? p.vendorUserId : p.customerUserId;
    this.gateway.emitToUsers([other, userId], 'message:read', { conversationId, readerUserId: userId, readAt });
    return { conversationId, readAt };
  }

  async setBlocked(userId: string, conversationId: string, blocked: boolean) {
    const p = await this.participation(userId, conversationId);
    if (!blocked && p.conversation.blockedByUserId && p.conversation.blockedByUserId !== userId) {
      throw new ForbiddenException('Only the person who blocked this chat can unblock it.');
    }
    const updated = await this.prisma.conversation.update({
      where: { id: conversationId },
      data: blocked ? { status: 'BLOCKED', blockedByUserId: userId } : { status: 'OPEN', blockedByUserId: null },
    });
    return this.conversationDto(updated, p.side);
  }

  /** Called on app open/resume and when a push arrives; also carries the notification inbox count. */
  async unreadSummary(userId: string) {
    const vendor = await this.prisma.vendorProfile.findUnique({
      where: { userId },
      select: { id: true, approvalStatus: true, rejectionReason: true, updatedAt: true },
    });
    const [asCustomer, asVendor, unreadNotifications] = await Promise.all([
      this.prisma.conversation.aggregate({
        where: { customerId: userId, customerUnread: { gt: 0 } },
        _count: true,
        _sum: { customerUnread: true },
      }),
      vendor
        ? this.prisma.conversation.aggregate({
            where: { vendorId: vendor.id, vendorUnread: { gt: 0 } },
            _count: true,
            _sum: { vendorUnread: true },
          })
        : Promise.resolve(null),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    return {
      unreadConversations: asCustomer._count + (asVendor?._count ?? 0),
      unreadMessages: (asCustomer._sum.customerUnread ?? 0) + (asVendor?._sum.vendorUnread ?? 0),
      unreadNotifications,
      vendorStatus: vendor?.approvalStatus ?? null,
      vendorRejectionReason: vendor?.rejectionReason ?? null,
    };
  }

  /** "Call" tap: passes the policy, logs it, and reveals the phone number to a logged-in user. */
  async call(userId: string, vendorId: string) {
    const vendor = await this.approvedVendor(vendorId);
    if (vendor.userId === userId) throw new BadRequestException('You cannot call your own shop.');
    if (!vendor.contactPhone) throw new NotFoundException('This seller has no phone number.');
    const decision = await this.policy.canAccess(userId, vendor.id, 'CALL');
    if (!decision.allowed) throw new ForbiddenException('Calling is not available for this seller.');
    await this.prisma.callLog.create({ data: { customerId: userId, vendorId: vendor.id } });
    return { vendorId: vendor.id, businessName: vendor.businessName, phone: vendor.contactPhone };
  }
}

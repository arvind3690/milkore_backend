import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ReportStatus, TicketStatus, VendorApprovalStatus } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { paginated } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../auth/token.service';
import { NotificationSender } from '../notifications/notification-sender';
import { NotificationsService } from '../notifications/notifications.service';
import { ProductsService } from '../vendors/products.service';
import { VendorsService } from '../vendors/vendors.service';

interface Page {
  page: number;
  limit: number;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vendors: VendorsService,
    private readonly products: ProductsService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly notifier: NotificationSender,
    private readonly notificationsSvc: NotificationsService,
  ) {}

  async stats() {
    const since = (days: number) => new Date(Date.now() - days * 86_400_000);
    const [customers, vendorUsers, byStatus, products, conversations, messages7d, calls7d, signups7d, signups30d, openReports, openTickets] =
      await Promise.all([
        this.prisma.user.count({ where: { role: 'CUSTOMER', status: { not: 'DELETED' } } }),
        this.prisma.user.count({ where: { role: 'VENDOR', status: { not: 'DELETED' } } }),
        this.prisma.vendorProfile.groupBy({ by: ['approvalStatus'], where: { deletedAt: null }, _count: true }),
        this.prisma.vendorProduct.count({ where: { deletedAt: null, moderationStatus: 'ACTIVE' } }),
        this.prisma.conversation.count(),
        this.prisma.message.count({ where: { createdAt: { gte: since(7) } } }),
        this.prisma.callLog.count({ where: { createdAt: { gte: since(7) } } }),
        this.prisma.user.count({ where: { createdAt: { gte: since(7) } } }),
        this.prisma.user.count({ where: { createdAt: { gte: since(30) } } }),
        this.prisma.report.count({ where: { status: 'OPEN' } }),
        this.prisma.supportTicket.count({ where: { status: { not: 'CLOSED' } } }),
      ]);
    const signupsByDay = await this.prisma.$queryRaw<{ day: string; customers: number; vendors: number }[]>`
      SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
             count(u.id) FILTER (WHERE u.role = 'CUSTOMER')::int AS customers,
             count(u.id) FILTER (WHERE u.role = 'VENDOR')::int AS vendors
      FROM generate_series(current_date - interval '29 days', current_date, interval '1 day') AS d(day)
      LEFT JOIN users u ON u.created_at::date = d.day::date
      GROUP BY d.day ORDER BY d.day`;
    const vendorsByStatus = Object.fromEntries(
      (['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'] as VendorApprovalStatus[]).map((s) => [
        s,
        byStatus.find((b) => b.approvalStatus === s)?._count ?? 0,
      ]),
    );
    return {
      customers,
      vendorUsers,
      vendorsByStatus,
      activeProducts: products,
      conversations,
      messagesLast7Days: messages7d,
      callsLast7Days: calls7d,
      signupsLast7Days: signups7d,
      signupsLast30Days: signups30d,
      openReports,
      openTickets,
      signupsByDay,
    };
  }

  // ─────────────────────────────── vendors ───────────────────────────────

  async listVendors(q: Page & { status?: VendorApprovalStatus; search?: string }) {
    const where: Prisma.VendorProfileWhereInput = {
      deletedAt: null,
      ...(q.status ? { approvalStatus: q.status } : {}),
      ...(q.search
        ? {
            OR: [
              { businessName: { contains: q.search, mode: 'insensitive' } },
              { ownerName: { contains: q.search, mode: 'insensitive' } },
              { contactPhone: { contains: q.search.replace(/\D/g, '') || q.search } },
              { location: { pincode: q.search } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.vendorProfile.count({ where }),
      this.prisma.vendorProfile.findMany({
        where,
        include: { location: { select: { city: true, locality: true, pincode: true } }, _count: { select: { products: { where: { deletedAt: null } } } } },
        // Pending first, oldest submission first (fair queue).
        orderBy: q.status === 'PENDING' ? [{ submittedAt: 'asc' }] : [{ updatedAt: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);
    const items = rows.map((v) => ({
      id: v.id,
      businessName: v.businessName,
      ownerName: v.ownerName,
      contactPhone: v.contactPhone,
      approvalStatus: v.approvalStatus,
      isAvailable: v.isAvailable,
      city: v.location?.city ?? null,
      locality: v.location?.locality ?? null,
      pincode: v.location?.pincode ?? null,
      productCount: v._count.products,
      submittedAt: v.submittedAt,
      createdAt: v.createdAt,
    }));
    return paginated(items, total, q);
  }

  async vendorDetail(id: string) {
    const vendor = await this.prisma.vendorProfile.findUnique({ where: { id } });
    if (!vendor) throw new NotFoundException('Vendor not found.');
    const [view, user, history, products, reports, chats, calls] = await Promise.all([
      this.vendors.ownerView(vendor),
      this.prisma.user.findUnique({ where: { id: vendor.userId }, select: { id: true, phone: true, name: true, status: true, createdAt: true, lastLoginAt: true } }),
      this.prisma.vendorApprovalHistory.findMany({ where: { vendorId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.vendorProduct.findMany({
        where: { vendorId: id, deletedAt: null },
        include: { category: true, unit: true, image: { select: { storageKey: true, status: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.report.count({ where: { targetType: 'VENDOR', targetId: id } }),
      this.prisma.conversation.count({ where: { vendorId: id } }),
      this.prisma.callLog.count({ where: { vendorId: id } }),
    ]);
    return {
      ...view,
      user,
      history,
      products: await Promise.all(products.map((p) => this.products.toDto(p))),
      counts: { reports, conversations: chats, calls },
    };
  }

  async transitionVendor(adminId: string, vendorId: string, to: VendorApprovalStatus, reason: string | null, ip: string) {
    if ((to === 'REJECTED' || to === 'SUSPENDED') && !reason?.trim()) {
      throw new BadRequestException({ message: 'Please give a reason.', errors: { reason: ['Reason is required'] } });
    }
    const result = await this.vendors.adminTransition(vendorId, to, adminId, reason?.trim() || null, ip);
    const vendor = await this.prisma.vendorProfile.findUniqueOrThrow({ where: { id: vendorId }, select: { userId: true } });
    await this.notifier.notifyVendorStatus(vendor.userId, { status: to, reason });
    return result;
  }

  // ─────────────────────────────── users ───────────────────────────────

  async listUsers(q: Page & { role?: 'CUSTOMER' | 'VENDOR'; status?: 'ACTIVE' | 'SUSPENDED' | 'DELETED'; search?: string }) {
    const digits = q.search?.replace(/\D/g, '');
    const where: Prisma.UserWhereInput = {
      ...(q.role ? { role: q.role } : {}),
      ...(q.status ? { status: q.status } : { status: { not: 'DELETED' } }),
      ...(q.search
        ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, ...(digits ? [{ phone: { contains: digits } }] : [])] }
        : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        select: {
          id: true, phone: true, name: true, role: true, status: true, preferredLanguage: true, createdAt: true, lastLoginAt: true,
          customerProfile: { select: { addressLabel: true, pincode: true } },
          vendorProfile: { select: { id: true, approvalStatus: true, businessName: true } },
        },
      }),
    ]);
    return paginated(items, total, q);
  }

  async setUserStatus(adminId: string, userId: string, status: 'ACTIVE' | 'SUSPENDED', reason: string | undefined, ip: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status === 'DELETED') throw new NotFoundException('User not found.');
    if (status === 'SUSPENDED' && !reason?.trim()) {
      throw new BadRequestException({ message: 'Please give a reason.', errors: { reason: ['Reason is required'] } });
    }
    await this.prisma.user.update({ where: { id: userId }, data: { status } });
    if (status === 'SUSPENDED') {
      await this.tokens.revokeAllForUser(userId);
      await this.notificationsSvc.removeAllDevices(userId); // a suspended account gets no pushes
    }
    await this.audit.record({
      actorType: 'ADMIN', actorId: adminId, action: `user.${status.toLowerCase()}`, entityType: 'user', entityId: userId, metadata: { reason: reason ?? null }, ip,
    });
    return { id: userId, status };
  }

  // ─────────────────────────────── catalogue & moderation ───────────────────────────────

  listCategories() {
    return this.prisma.productCategory.findMany({ orderBy: { sortOrder: 'asc' }, include: { _count: { select: { products: true } } } });
  }

  async createCategory(adminId: string, data: { slug: string; nameEn: string; nameHi: string; iconKey: string; sortOrder?: number }, ip: string) {
    const exists = await this.prisma.productCategory.findUnique({ where: { slug: data.slug } });
    if (exists) throw new ConflictException('A category with this slug already exists.');
    const c = await this.prisma.productCategory.create({ data: { ...data, sortOrder: data.sortOrder ?? 50 } });
    await this.audit.record({ actorType: 'ADMIN', actorId: adminId, action: 'category.create', entityType: 'category', entityId: c.id, ip });
    return c;
  }

  async updateCategory(adminId: string, id: string, data: Partial<{ nameEn: string; nameHi: string; iconKey: string; sortOrder: number; isActive: boolean }>, ip: string) {
    const c = await this.prisma.productCategory.update({ where: { id }, data });
    await this.audit.record({ actorType: 'ADMIN', actorId: adminId, action: 'category.update', entityType: 'category', entityId: id, metadata: data, ip });
    return c;
  }

  async listProducts(q: Page & { search?: string; vendorId?: string; status?: 'ACTIVE' | 'REMOVED_BY_ADMIN' }) {
    const where: Prisma.VendorProductWhereInput = {
      deletedAt: null,
      ...(q.vendorId ? { vendorId: q.vendorId } : {}),
      ...(q.status ? { moderationStatus: q.status } : {}),
      ...(q.search ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { vendor: { businessName: { contains: q.search, mode: 'insensitive' } } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.vendorProduct.count({ where }),
      this.prisma.vendorProduct.findMany({
        where,
        include: { category: true, unit: true, image: { select: { storageKey: true, status: true } }, vendor: { select: { id: true, businessName: true } } },
        orderBy: { updatedAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);
    const items = await Promise.all(rows.map(async (p) => ({ ...(await this.products.toDto(p)), vendor: p.vendor })));
    return paginated(items, total, q);
  }

  async moderateProduct(adminId: string, id: string, remove: boolean, reason: string | undefined, ip: string) {
    if (remove && !reason?.trim()) throw new BadRequestException({ message: 'Please give a reason.', errors: { reason: ['Reason is required'] } });
    const p = await this.prisma.vendorProduct.update({
      where: { id },
      data: remove ? { moderationStatus: 'REMOVED_BY_ADMIN', removedReason: reason!.trim() } : { moderationStatus: 'ACTIVE', removedReason: null },
    });
    await this.audit.record({
      actorType: 'ADMIN', actorId: adminId, action: remove ? 'product.remove' : 'product.restore', entityType: 'product', entityId: id, metadata: { reason: reason ?? null }, ip,
    });
    const vendor = await this.prisma.vendorProfile.findUnique({ where: { id: p.vendorId }, select: { userId: true } });
    if (vendor) {
      await this.notifier.notifyProductModerated(vendor.userId, { productId: p.id, productName: p.name, removed: remove, reason: p.removedReason });
    }
    return { id: p.id, moderationStatus: p.moderationStatus, removedReason: p.removedReason };
  }

  // ─────────────────────────────── reports, support, audit ───────────────────────────────

  async listReports(q: Page & { status?: ReportStatus }) {
    const where = q.status ? { status: q.status } : {};
    const [total, rows] = await Promise.all([
      this.prisma.report.count({ where }),
      this.prisma.report.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    const reporters = await this.prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.reporterUserId) } },
      select: { id: true, name: true, phone: true },
    });
    const items = await Promise.all(
      rows.map(async (r) => ({
        ...r,
        reporter: reporters.find((u) => u.id === r.reporterUserId) ?? null,
        targetLabel: await this.targetLabel(r.targetType, r.targetId),
      })),
    );
    return paginated(items, total, q);
  }

  private async targetLabel(type: string, id: string): Promise<string | null> {
    if (type === 'VENDOR') return (await this.prisma.vendorProfile.findUnique({ where: { id }, select: { businessName: true } }))?.businessName ?? null;
    if (type === 'PRODUCT') return (await this.prisma.vendorProduct.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
    if (type === 'USER') return (await this.prisma.user.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
    if (type === 'MESSAGE') return (await this.prisma.message.findUnique({ where: { id }, select: { body: true } }))?.body.slice(0, 80) ?? null;
    return null;
  }

  async resolveReport(adminId: string, id: string, status: ReportStatus, note: string | undefined, ip: string) {
    const before = await this.prisma.report.findUnique({ where: { id }, select: { status: true } });
    const r = await this.prisma.report.update({
      where: { id },
      data: { status, resolutionNote: note?.trim() || null, resolvedByAdminId: status === 'OPEN' ? null : adminId, resolvedAt: status === 'OPEN' ? null : new Date() },
    });
    await this.audit.record({ actorType: 'ADMIN', actorId: adminId, action: `report.${status.toLowerCase()}`, entityType: 'report', entityId: id, ip });
    // Tell the reporter once, when the report is first closed (not on every edit).
    if (status !== 'OPEN' && before?.status === 'OPEN') {
      await this.notifier.notifyReportResolved(r.reporterUserId, { reportId: r.id, status });
    }
    return r;
  }

  async listTickets(q: Page & { status?: TicketStatus }) {
    const where = q.status ? { status: q.status } : {};
    const [total, rows] = await Promise.all([
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.findMany({ where, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    const users = await this.prisma.user.findMany({ where: { id: { in: rows.map((t) => t.userId) } }, select: { id: true, name: true, phone: true, role: true } });
    return paginated(rows.map((t) => ({ ...t, user: users.find((u) => u.id === t.userId) ?? null })), total, q);
  }

  async updateTicket(adminId: string, id: string, data: { status?: TicketStatus; adminNote?: string }, ip: string) {
    const before = await this.prisma.supportTicket.findUnique({ where: { id }, select: { status: true, adminNote: true } });
    const t = await this.prisma.supportTicket.update({ where: { id }, data: { ...data, adminNote: data.adminNote?.trim() } });
    await this.audit.record({ actorType: 'ADMIN', actorId: adminId, action: 'ticket.update', entityType: 'ticket', entityId: id, metadata: { status: data.status ?? null }, ip });
    // Notify only when something the user can see changed: the status or the reply.
    const noteChanged = !!t.adminNote && t.adminNote !== before?.adminNote;
    if (before && (t.status !== before.status || noteChanged)) {
      await this.notifier.notifySupportUpdate(t.userId, { ticketId: t.id, subject: t.subject, status: t.status, note: noteChanged ? t.adminNote : null });
    }
    return t;
  }

  async auditLogs(q: Page & { entityType?: string; entityId?: string; actorId?: string }) {
    const where: Prisma.AuditLogWhereInput = {
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.actorId ? { actorId: q.actorId } : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    return paginated(items, total, q);
  }
}

import { NotificationTarget, Prisma, UserRole, VendorApprovalStatus } from '@prisma/client';

/** Who an admin campaign goes to. Stored as-is on the campaign for the history view. */
export type Audience =
  | { type: 'ALL' }
  | { type: 'ROLE'; role: UserRole }
  | { type: 'USERS'; userIds: string[] }
  | { type: 'LOCATION'; role?: UserRole; city?: string; pincode?: string }
  | { type: 'VENDOR_STATUS'; approvalStatus: VendorApprovalStatus };

/** Broadcasts to a whole role (or everyone) need a super admin. */
export function isBroadcast(a: Audience): boolean {
  return a.type === 'ALL' || a.type === 'ROLE';
}

/** True when every possible recipient is a vendor (vendor-only screens are then safe targets). */
export function isVendorOnly(a: Audience): boolean {
  return (a.type === 'ROLE' && a.role === 'VENDOR') || a.type === 'VENDOR_STATUS' || (a.type === 'LOCATION' && a.role === 'VENDOR');
}

export const VENDOR_ONLY_TARGETS: NotificationTarget[] = ['VENDOR_DASHBOARD', 'VENDOR_PRODUCTS'];

/** Targets an admin may pick. CHAT is automatic-only (a campaign can't point at someone's private chat). */
export const CAMPAIGN_TARGETS: NotificationTarget[] = ['HOME', 'NOTIFICATIONS', 'VENDOR_DASHBOARD', 'VENDOR_PRODUCTS', 'SUPPORT', 'VENDOR_DETAILS'];

/** Prisma filter for the audience. Only active, non-deleted users ever receive campaigns. */
export function audienceWhere(a: Audience): Prisma.UserWhereInput {
  const base: Prisma.UserWhereInput = { status: 'ACTIVE', deletedAt: null };
  switch (a.type) {
    case 'ALL':
      return base;
    case 'ROLE':
      return { ...base, role: a.role };
    case 'USERS':
      return { ...base, id: { in: a.userIds } };
    case 'VENDOR_STATUS':
      return { ...base, role: 'VENDOR', vendorProfile: { approvalStatus: a.approvalStatus, deletedAt: null } };
    case 'LOCATION': {
      const city = a.city?.trim();
      const pin = a.pincode?.trim();
      const or: Prisma.UserWhereInput[] = [];
      if (pin) {
        or.push(
          { customerProfile: { pincode: pin } },
          { vendorProfile: { deletedAt: null, location: { pincode: pin } } },
          { vendorProfile: { deletedAt: null, serviceAreas: { some: { pincode: pin } } } },
        );
      }
      if (city) {
        or.push(
          { customerProfile: { city: { equals: city, mode: 'insensitive' } } },
          { vendorProfile: { deletedAt: null, location: { city: { equals: city, mode: 'insensitive' } } } },
        );
      }
      return { ...base, ...(a.role ? { role: a.role } : {}), OR: or };
    }
  }
}

/** Short human label for tables and the audit log. */
export function describeAudience(a: Audience): string {
  switch (a.type) {
    case 'ALL':
      return 'All users';
    case 'ROLE':
      return a.role === 'VENDOR' ? 'All vendors' : 'All customers';
    case 'USERS':
      return `${a.userIds.length} selected user(s)`;
    case 'VENDOR_STATUS':
      return `Vendors: ${a.approvalStatus}`;
    case 'LOCATION': {
      const where = [a.city, a.pincode].filter(Boolean).join(' / ');
      const who = a.role === 'VENDOR' ? 'Vendors' : a.role === 'CUSTOMER' ? 'Customers' : 'Users';
      return `${who} in ${where}`;
    }
  }
}

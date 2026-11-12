import { User, VendorApprovalStatus } from '@prisma/client';

export interface UserDto {
  id: string;
  phone: string;
  name: string | null;
  role: User['role'];
  status: User['status'];
  preferredLanguage: User['preferredLanguage'];
  vendorStatus: VendorApprovalStatus | null;
  createdAt: Date;
}

export function toUserDto(
  user: User,
  vendor?: { approvalStatus: VendorApprovalStatus } | null,
): UserDto {
  return {
    id: user.id,
    phone: user.phone,
    name: user.name,
    role: user.role,
    status: user.status,
    preferredLanguage: user.preferredLanguage,
    vendorStatus: vendor?.approvalStatus ?? null,
    createdAt: user.createdAt,
  };
}

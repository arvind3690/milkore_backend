import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, VendorApprovalStatus, VendorProfile } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../auth/token.service';
import { assertInIndia } from '../locations/geo';
import { MediaService } from '../media/media.service';
import {
  OperatingHours,
  VendorBusinessDto,
  VendorLocationDto,
  VendorPhotosDto,
  VendorServiceAreasDto,
  WEEKDAYS,
} from './vendor.dto';

export interface VendorLocationRow {
  addressLine: string;
  locality: string;
  city: string;
  district: string;
  state: string;
  pincode: string;
  lat: number;
  lng: number;
}

export const ONBOARDING_STEPS = ['business', 'photos', 'location', 'serviceAreas', 'hours'] as const;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateHours(hours: unknown): OperatingHours {
  const errors: string[] = [];
  if (!hours || typeof hours !== 'object') errors.push('operatingHours must be an object');
  const h = (hours ?? {}) as Record<string, { open?: unknown; close?: unknown; closed?: unknown }>;
  for (const day of WEEKDAYS) {
    const d = h[day];
    if (!d) {
      errors.push(`${day} is missing`);
      continue;
    }
    if (typeof d.closed !== 'boolean') errors.push(`${day}.closed must be true/false`);
    if (!d.closed) {
      if (typeof d.open !== 'string' || !TIME_RE.test(d.open)) errors.push(`${day}.open must be HH:mm`);
      if (typeof d.close !== 'string' || !TIME_RE.test(d.close)) errors.push(`${day}.close must be HH:mm`);
    }
  }
  if (Object.keys(h).some((k) => !(WEEKDAYS as readonly string[]).includes(k))) errors.push('unknown day key');
  if (errors.length) {
    throw new BadRequestException({ message: 'Please check the shop timings.', errors: { operatingHours: errors } });
  }
  return Object.fromEntries(
    WEEKDAYS.map((d) => [d, { open: String(h[d]!.open ?? '00:00'), close: String(h[d]!.close ?? '00:00'), closed: Boolean(h[d]!.closed) }]),
  ) as OperatingHours;
}

@Injectable()
export class VendorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  // ─────────────────────────────── reads ───────────────────────────────

  async findByUser(userId: string): Promise<VendorProfile> {
    const vendor = await this.prisma.vendorProfile.findUnique({ where: { userId } });
    if (!vendor || vendor.deletedAt) throw new NotFoundException('Please start vendor registration first.');
    return vendor;
  }

  async location(vendorId: string): Promise<VendorLocationRow | null> {
    const [row] = await this.prisma.$queryRaw<VendorLocationRow[]>`
      SELECT address_line AS "addressLine", locality, city, district, state, pincode,
             ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
      FROM vendor_locations WHERE vendor_id = ${vendorId}::uuid`;
    return row ? { ...row, lat: Number(row.lat), lng: Number(row.lng) } : null;
  }

  async serviceAreas(vendorId: string) {
    const areas = await this.prisma.vendorServiceArea.findMany({ where: { vendorId }, orderBy: { createdAt: 'asc' } });
    return {
      radiusMeters: areas.find((a) => a.type === 'RADIUS')?.radiusMeters ?? null,
      pincodes: areas.filter((a) => a.type === 'PINCODE').map((a) => a.pincode!),
      localities: areas.filter((a) => a.type === 'LOCALITY').map((a) => a.localityName!),
    };
  }

  completion(vendor: VendorProfile, hasLocation: boolean, areas: { radiusMeters: number | null; pincodes: string[]; localities: string[] }) {
    const done: Record<(typeof ONBOARDING_STEPS)[number], boolean> = {
      business: Boolean(vendor.ownerName && vendor.businessName),
      photos: Boolean(vendor.profilePhotoId),
      location: hasLocation,
      serviceAreas: Boolean(areas.radiusMeters || areas.pincodes.length || areas.localities.length),
      hours: Boolean(vendor.operatingHours),
    };
    const missing = ONBOARDING_STEPS.filter((s) => !done[s]);
    return {
      steps: done,
      missing,
      completedSteps: ONBOARDING_STEPS.length - missing.length,
      totalSteps: ONBOARDING_STEPS.length,
      percent: Math.round(((ONBOARDING_STEPS.length - missing.length) / ONBOARDING_STEPS.length) * 100),
    };
  }

  /** Full vendor view for the owner (and admins). */
  async ownerView(vendor: VendorProfile) {
    const [location, areas, profilePhotoUrl, shopPhotoUrl] = await Promise.all([
      this.location(vendor.id),
      this.serviceAreas(vendor.id),
      this.media.urlForId(vendor.profilePhotoId),
      this.media.urlForId(vendor.shopPhotoId),
    ]);
    return {
      id: vendor.id,
      approvalStatus: vendor.approvalStatus,
      rejectionReason: vendor.rejectionReason,
      suspensionReason: vendor.suspensionReason,
      ownerName: vendor.ownerName,
      businessName: vendor.businessName,
      description: vendor.description,
      operatingHours: vendor.operatingHours as OperatingHours | null,
      isAvailable: vendor.isAvailable,
      contactPhone: vendor.contactPhone,
      profilePhotoId: vendor.profilePhotoId,
      shopPhotoId: vendor.shopPhotoId,
      profilePhotoUrl,
      shopPhotoUrl,
      location,
      serviceAreas: areas,
      completion: this.completion(vendor, Boolean(location), areas),
      submittedAt: vendor.submittedAt,
      approvedAt: vendor.approvedAt,
      createdAt: vendor.createdAt,
    };
  }

  async ownerViewByUser(userId: string) {
    return this.ownerView(await this.findByUser(userId));
  }

  // ─────────────────────────────── onboarding ───────────────────────────────

  /** Creates the DRAFT profile and upgrades the user to VENDOR. Returns fresh tokens for the new role. */
  async start(userId: string, ip: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    let vendor = await this.prisma.vendorProfile.findUnique({ where: { userId } });
    if (vendor?.deletedAt) throw new ConflictException('This vendor account was closed. Please contact support.');
    if (!vendor) {
      [vendor] = await this.prisma.$transaction([
        this.prisma.vendorProfile.create({
          data: { userId, ownerName: user.name, contactPhone: user.phone },
        }),
        this.prisma.user.update({ where: { id: userId }, data: { role: 'VENDOR' } }),
      ]);
      await this.audit.record({ actorType: 'USER', actorId: userId, action: 'vendor.start', entityType: 'vendor', entityId: vendor.id, ip });
    }
    const tokens = await this.tokens.issue({ id: userId, role: 'VENDOR' });
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      vendor: await this.ownerView(vendor),
    };
  }

  /**
   * Edits that change what customers trust (name, location, profile photo) send an
   * APPROVED vendor back to PENDING for re-review. Hours, description, areas and
   * availability never do.
   */
  private async afterSensitiveEdit(vendor: VendorProfile, what: string) {
    if (vendor.approvalStatus !== 'APPROVED') return;
    await this.transition(vendor, 'PENDING', null, `Re-review after ${what} change`);
  }

  private async transition(vendor: VendorProfile, to: VendorApprovalStatus, adminId: string | null, note: string | null) {
    await this.prisma.$transaction([
      this.prisma.vendorProfile.update({
        where: { id: vendor.id },
        data: {
          approvalStatus: to,
          ...(to === 'PENDING' ? { submittedAt: new Date() } : {}),
        },
      }),
      this.prisma.vendorApprovalHistory.create({
        data: { vendorId: vendor.id, fromStatus: vendor.approvalStatus, toStatus: to, adminId, note },
      }),
    ]);
  }

  private assertEditable(vendor: VendorProfile) {
    if (vendor.approvalStatus === 'SUSPENDED') {
      throw new ConflictException('Your shop is suspended. Please contact Milkore support.');
    }
  }

  async updateBusiness(userId: string, dto: VendorBusinessDto) {
    const vendor = await this.findByUser(userId);
    this.assertEditable(vendor);
    const data: Prisma.VendorProfileUpdateInput = {};
    if (dto.ownerName !== undefined) data.ownerName = dto.ownerName.trim();
    if (dto.businessName !== undefined) data.businessName = dto.businessName.trim();
    if (dto.description !== undefined) data.description = dto.description.trim() || null;
    if (dto.operatingHours !== undefined) data.operatingHours = validateHours(dto.operatingHours);
    const nameChanged = dto.businessName !== undefined && dto.businessName.trim() !== vendor.businessName;
    const updated = await this.prisma.vendorProfile.update({ where: { id: vendor.id }, data });
    if (nameChanged) await this.afterSensitiveEdit(vendor, 'business name');
    if (dto.ownerName) await this.prisma.user.update({ where: { id: userId }, data: { name: dto.ownerName.trim() } });
    return this.ownerView(await this.prisma.vendorProfile.findUniqueOrThrow({ where: { id: updated.id } }));
  }

  async updatePhotos(userId: string, dto: VendorPhotosDto) {
    const vendor = await this.findByUser(userId);
    this.assertEditable(vendor);
    await this.media.requireReady(userId, dto.profilePhotoId, 'VENDOR_PROFILE');
    if (dto.shopPhotoId) await this.media.requireReady(userId, dto.shopPhotoId, 'VENDOR_SHOP');
    await this.prisma.vendorProfile.update({
      where: { id: vendor.id },
      data: {
        profilePhotoId: dto.profilePhotoId,
        ...(dto.shopPhotoId !== undefined ? { shopPhotoId: dto.shopPhotoId } : {}),
      },
    });
    if (vendor.profilePhotoId && vendor.profilePhotoId !== dto.profilePhotoId) {
      await this.afterSensitiveEdit(vendor, 'profile photo');
    }
    return this.ownerViewByUser(userId);
  }

  async updateLocation(userId: string, dto: VendorLocationDto) {
    const vendor = await this.findByUser(userId);
    this.assertEditable(vendor);
    assertInIndia(dto.lat, dto.lng);
    const before = await this.location(vendor.id);
    await this.prisma.$executeRaw`
      INSERT INTO vendor_locations (id, vendor_id, address_line, locality, city, district, state, pincode, location, updated_at)
      VALUES (gen_random_uuid(), ${vendor.id}::uuid, ${dto.addressLine.trim()}, ${dto.locality.trim()}, ${dto.city.trim()},
              ${dto.district.trim()}, ${dto.state.trim()}, ${dto.pincode},
              ST_SetSRID(ST_MakePoint(${dto.lng}, ${dto.lat}), 4326)::geography, now())
      ON CONFLICT (vendor_id) DO UPDATE SET
        address_line = EXCLUDED.address_line, locality = EXCLUDED.locality, city = EXCLUDED.city,
        district = EXCLUDED.district, state = EXCLUDED.state, pincode = EXCLUDED.pincode,
        location = EXCLUDED.location, updated_at = now()`;
    // Teach the PIN cache a coordinate for this PIN (improves GPS→PIN fallback).
    await this.prisma.$executeRaw`
      UPDATE post_offices SET location = ST_SetSRID(ST_MakePoint(${dto.lng}, ${dto.lat}), 4326)::geography
      WHERE pincode = ${dto.pincode} AND location IS NULL`;
    const moved =
      before &&
      (before.pincode !== dto.pincode || Math.abs(before.lat - dto.lat) > 0.002 || Math.abs(before.lng - dto.lng) > 0.002);
    if (moved) await this.afterSensitiveEdit(vendor, 'location');
    return this.ownerViewByUser(userId);
  }

  async updateServiceAreas(userId: string, dto: VendorServiceAreasDto) {
    const vendor = await this.findByUser(userId);
    this.assertEditable(vendor);
    const pincodes = [...new Set(dto.pincodes ?? [])];
    const localities = [...new Set((dto.localities ?? []).map((l) => l.trim()).filter(Boolean))];
    if (!dto.radiusMeters && !pincodes.length && !localities.length) {
      throw new BadRequestException({
        message: 'Choose a distance or add at least one area where you sell.',
        errors: { serviceAreas: ['At least one service area is required'] },
      });
    }
    await this.prisma.$transaction([
      this.prisma.vendorServiceArea.deleteMany({ where: { vendorId: vendor.id } }),
      this.prisma.vendorServiceArea.createMany({
        data: [
          ...(dto.radiusMeters ? [{ vendorId: vendor.id, type: 'RADIUS' as const, radiusMeters: dto.radiusMeters }] : []),
          ...pincodes.map((pincode) => ({ vendorId: vendor.id, type: 'PINCODE' as const, pincode })),
          ...localities.map((localityName) => ({ vendorId: vendor.id, type: 'LOCALITY' as const, localityName })),
        ],
      }),
    ]);
    return this.ownerViewByUser(userId);
  }

  async setAvailability(userId: string, isAvailable: boolean) {
    const vendor = await this.findByUser(userId);
    await this.prisma.vendorProfile.update({ where: { id: vendor.id }, data: { isAvailable } });
    return { isAvailable };
  }

  async submit(userId: string, ip: string) {
    const vendor = await this.findByUser(userId);
    if (vendor.approvalStatus === 'PENDING') return this.ownerView(vendor);
    if (vendor.approvalStatus === 'APPROVED') throw new ConflictException('Your shop is already approved.');
    if (vendor.approvalStatus === 'SUSPENDED') throw new ConflictException('Your shop is suspended. Please contact Milkore support.');
    const view = await this.ownerView(vendor);
    if (view.completion.missing.length) {
      throw new BadRequestException({
        message: 'Please complete all steps before submitting.',
        errors: { missing: view.completion.missing },
      });
    }
    await this.prisma.$transaction([
      this.prisma.vendorProfile.update({
        where: { id: vendor.id },
        data: { approvalStatus: 'PENDING', submittedAt: new Date(), rejectionReason: null, onboardingStep: ONBOARDING_STEPS.length },
      }),
      this.prisma.vendorApprovalHistory.create({
        data: { vendorId: vendor.id, fromStatus: vendor.approvalStatus, toStatus: 'PENDING', note: 'Submitted by vendor' },
      }),
    ]);
    await this.audit.record({ actorType: 'USER', actorId: userId, action: 'vendor.submit', entityType: 'vendor', entityId: vendor.id, ip });
    return this.ownerViewByUser(userId);
  }

  // ─────────────────────────────── admin transitions ───────────────────────────────

  async adminTransition(vendorId: string, to: VendorApprovalStatus, adminId: string, reason: string | null, ip: string) {
    const vendor = await this.prisma.vendorProfile.findUnique({ where: { id: vendorId } });
    if (!vendor || vendor.deletedAt) throw new NotFoundException('Vendor not found.');
    const allowed: Record<VendorApprovalStatus, VendorApprovalStatus[]> = {
      DRAFT: [],
      PENDING: ['APPROVED', 'REJECTED', 'SUSPENDED'],
      APPROVED: ['SUSPENDED', 'REJECTED'],
      REJECTED: ['APPROVED', 'SUSPENDED'],
      SUSPENDED: ['APPROVED'],
    };
    if (!allowed[vendor.approvalStatus].includes(to)) {
      throw new ConflictException(`A ${vendor.approvalStatus.toLowerCase()} vendor cannot be moved to ${to.toLowerCase()}.`);
    }
    await this.prisma.$transaction([
      this.prisma.vendorProfile.update({
        where: { id: vendor.id },
        data: {
          approvalStatus: to,
          ...(to === 'APPROVED' ? { approvedAt: new Date(), approvedByAdminId: adminId, rejectionReason: null, suspensionReason: null } : {}),
          ...(to === 'REJECTED' ? { rejectionReason: reason } : {}),
          ...(to === 'SUSPENDED' ? { suspensionReason: reason } : {}),
        },
      }),
      this.prisma.vendorApprovalHistory.create({
        data: { vendorId: vendor.id, fromStatus: vendor.approvalStatus, toStatus: to, adminId, note: reason },
      }),
    ]);
    await this.audit.record({
      actorType: 'ADMIN',
      actorId: adminId,
      action: `vendor.${to.toLowerCase()}`,
      entityType: 'vendor',
      entityId: vendor.id,
      metadata: { from: vendor.approvalStatus, reason },
      ip,
    });
    return this.ownerView(await this.prisma.vendorProfile.findUniqueOrThrow({ where: { id: vendor.id } }));
  }
}

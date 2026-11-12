import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { paginated } from '../../common/dto/pagination.dto';
import { formatRupees } from '../../common/utils/mask';
import { PrismaService } from '../../prisma/prisma.service';
import { assertInIndia } from '../locations/geo';
import { LocationsService } from '../locations/locations.service';
import { MediaService } from '../media/media.service';
import { ProductsService } from '../vendors/products.service';
import { VendorsService } from '../vendors/vendors.service';

export interface DiscoveryQuery {
  lat?: number;
  lng?: number;
  pincode?: string;
  locality?: string;
  categoryId?: string;
  q?: string;
  availableOnly?: boolean;
  page: number;
  limit: number;
}

interface VendorRow {
  id: string;
  businessName: string;
  description: string | null;
  isAvailable: boolean;
  locality: string;
  city: string;
  pincode: string;
  profileKey: string | null;
  shopKey: string | null;
  distanceMeters: number | null;
  total: number;
}

/** Hard cap so the radius branch can use the GIST index (max allowed service radius). */
const MAX_RADIUS_M = 20_000;

@Injectable()
export class DiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly locations: LocationsService,
    private readonly media: MediaService,
    private readonly vendors: VendorsService,
    private readonly products: ProductsService,
  ) {}

  /** Resolves the customer point: explicit lat/lng, else a known centroid for the PIN. */
  private async resolvePoint(q: DiscoveryQuery): Promise<{ lat: number; lng: number } | null> {
    if (q.lat !== undefined && q.lng !== undefined) {
      assertInIndia(q.lat, q.lng);
      return { lat: q.lat, lng: q.lng };
    }
    if (q.lat !== undefined || q.lng !== undefined) {
      throw new BadRequestException({ message: 'Send both lat and lng.', errors: { location: ['lat and lng go together'] } });
    }
    if (!q.pincode) {
      throw new BadRequestException({ message: 'Please choose your location first.', errors: { location: ['lat/lng or pincode required'] } });
    }
    return this.locations.centroidForPincode(q.pincode);
  }

  /**
   * The matching rule: APPROVED, user ACTIVE, not deleted, AND the customer is inside
   * one of the vendor's service areas (radius from the shop, a served PIN, or a served locality).
   */
  private where(point: { lat: number; lng: number } | null, q: DiscoveryQuery): Prisma.Sql {
    const pt = point ? Prisma.sql`ST_SetSRID(ST_MakePoint(${point.lng}, ${point.lat}), 4326)::geography` : null;
    const coverage: Prisma.Sql[] = [];
    if (pt) {
      coverage.push(Prisma.sql`(ST_DWithin(vl.location, ${pt}, ${MAX_RADIUS_M}) AND EXISTS (
        SELECT 1 FROM vendor_service_areas a WHERE a.vendor_id = v.id AND a.type = 'RADIUS'
          AND ST_DWithin(vl.location, ${pt}, a.radius_meters)))`);
    }
    if (q.pincode) {
      coverage.push(Prisma.sql`EXISTS (SELECT 1 FROM vendor_service_areas a
        WHERE a.vendor_id = v.id AND a.type = 'PINCODE' AND a.pincode = ${q.pincode})`);
    }
    if (q.locality) {
      coverage.push(Prisma.sql`EXISTS (SELECT 1 FROM vendor_service_areas a
        WHERE a.vendor_id = v.id AND a.type = 'LOCALITY' AND lower(a.locality_name) = lower(${q.locality}))`);
    }
    if (!coverage.length) return Prisma.sql`FALSE`;

    const filters: Prisma.Sql[] = [
      Prisma.sql`v.approval_status = 'APPROVED'`,
      Prisma.sql`v.deleted_at IS NULL`,
      Prisma.sql`u.status = 'ACTIVE'`,
      Prisma.sql`(${Prisma.join(coverage, ' OR ')})`,
    ];
    if (q.availableOnly) filters.push(Prisma.sql`v.is_available`);
    if (q.categoryId) {
      filters.push(Prisma.sql`EXISTS (SELECT 1 FROM vendor_products p WHERE p.vendor_id = v.id
        AND p.category_id = ${q.categoryId}::uuid AND p.deleted_at IS NULL AND p.moderation_status = 'ACTIVE'
        ${q.availableOnly ? Prisma.sql`AND p.is_available` : Prisma.empty})`);
    }
    if (q.q) {
      const like = `%${q.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      filters.push(Prisma.sql`(v.business_name ILIKE ${like} OR EXISTS (SELECT 1 FROM vendor_products p
        WHERE p.vendor_id = v.id AND p.deleted_at IS NULL AND p.moderation_status = 'ACTIVE' AND p.name ILIKE ${like}))`);
    }
    return Prisma.join(filters, ' AND ');
  }

  private distanceExpr(point: { lat: number; lng: number } | null): Prisma.Sql {
    return point
      ? Prisma.sql`ST_Distance(vl.location, ST_SetSRID(ST_MakePoint(${point.lng}, ${point.lat}), 4326)::geography)`
      : Prisma.sql`NULL::float8`;
  }

  async vendorsNear(q: DiscoveryQuery) {
    const point = await this.resolvePoint(q);
    const rows = await this.prisma.$queryRaw<VendorRow[]>`
      SELECT v.id, v.business_name AS "businessName", v.description, v.is_available AS "isAvailable",
             vl.locality, vl.city, vl.pincode,
             pm.storage_key AS "profileKey", sm.storage_key AS "shopKey",
             ${this.distanceExpr(point)} AS "distanceMeters",
             count(*) OVER()::int AS total
      FROM vendor_profiles v
      JOIN users u ON u.id = v.user_id
      JOIN vendor_locations vl ON vl.vendor_id = v.id
      LEFT JOIN media_assets pm ON pm.id = v.profile_photo_id AND pm.status = 'READY'
      LEFT JOIN media_assets sm ON sm.id = v.shop_photo_id AND sm.status = 'READY'
      WHERE ${this.where(point, q)}
      ORDER BY "distanceMeters" ASC NULLS LAST, v.is_available DESC, v.business_name ASC
      LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`;

    const total = rows[0]?.total ?? 0;
    const topProducts = await this.topProducts(rows.map((r) => r.id), q.categoryId);
    const items = await Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        businessName: r.businessName,
        description: r.description,
        isAvailable: r.isAvailable,
        locality: r.locality,
        city: r.city,
        pincode: r.pincode,
        distanceMeters: r.distanceMeters === null ? null : Math.round(Number(r.distanceMeters)),
        profilePhotoUrl: await this.media.url(r.profileKey),
        shopPhotoUrl: await this.media.url(r.shopKey),
        products: topProducts.get(r.id) ?? [],
      })),
    );

    const page = paginated(items, total, q);
    return {
      ...page,
      nearestServingDistanceKm: total === 0 && point ? await this.nearestApprovedKm(point) : null,
    };
  }

  /** Up to 3 products per vendor (preferring the requested category, then available ones). */
  private async topProducts(vendorIds: string[], categoryId?: string) {
    const map = new Map<string, { id: string; name: string; categorySlug: string; pricePaise: number; priceDisplay: string; priceDisplayHi: string; isAvailable: boolean }[]>();
    if (!vendorIds.length) return map;
    const products = await this.prisma.vendorProduct.findMany({
      where: { vendorId: { in: vendorIds }, deletedAt: null, moderationStatus: 'ACTIVE' },
      include: { unit: true, category: true },
      orderBy: [{ isAvailable: 'desc' }, { category: { sortOrder: 'asc' } }, { pricePaise: 'asc' }],
    });
    const sorted = categoryId
      ? [...products].sort((a, b) => Number(b.categoryId === categoryId) - Number(a.categoryId === categoryId))
      : products;
    for (const p of sorted) {
      const list = map.get(p.vendorId) ?? [];
      if (list.length < 3) {
        list.push({
          id: p.id,
          name: p.name,
          categorySlug: p.category.slug,
          pricePaise: p.pricePaise,
          priceDisplay: `${formatRupees(p.pricePaise)} / ${p.unit.labelEn}`,
          priceDisplayHi: `${formatRupees(p.pricePaise)} / ${p.unit.labelHi}`,
          isAvailable: p.isAvailable,
        });
      }
      map.set(p.vendorId, list);
    }
    return map;
  }

  private async nearestApprovedKm(point: { lat: number; lng: number }): Promise<number | null> {
    const [row] = await this.prisma.$queryRaw<{ d: number }[]>`
      SELECT ST_Distance(vl.location, ST_SetSRID(ST_MakePoint(${point.lng}, ${point.lat}), 4326)::geography) AS d
      FROM vendor_locations vl
      JOIN vendor_profiles v ON v.id = vl.vendor_id AND v.approval_status = 'APPROVED' AND v.deleted_at IS NULL
      ORDER BY vl.location <-> ST_SetSRID(ST_MakePoint(${point.lng}, ${point.lat}), 4326)::geography
      LIMIT 1`;
    return row ? Math.round((Number(row.d) / 1000) * 10) / 10 : null;
  }

  /** "Explore products": products of vendors serving this location. */
  async productsNear(q: DiscoveryQuery) {
    const point = await this.resolvePoint(q);
    const vendorRows = await this.prisma.$queryRaw<{ id: string; distanceMeters: number | null }[]>`
      SELECT v.id, ${this.distanceExpr(point)} AS "distanceMeters"
      FROM vendor_profiles v
      JOIN users u ON u.id = v.user_id
      JOIN vendor_locations vl ON vl.vendor_id = v.id
      WHERE ${this.where(point, { ...q, q: undefined })}
      ORDER BY "distanceMeters" ASC NULLS LAST
      LIMIT 200`;
    const distance = new Map(vendorRows.map((r) => [r.id, r.distanceMeters === null ? null : Math.round(Number(r.distanceMeters))]));
    const where: Prisma.VendorProductWhereInput = {
      vendorId: { in: vendorRows.map((r) => r.id) },
      deletedAt: null,
      moderationStatus: 'ACTIVE',
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.availableOnly ? { isAvailable: true } : {}),
      ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
    };
    const [total, products] = await Promise.all([
      this.prisma.vendorProduct.count({ where }),
      this.prisma.vendorProduct.findMany({
        where,
        include: {
          category: true,
          unit: true,
          image: { select: { storageKey: true, status: true } },
          vendor: { select: { id: true, businessName: true, isAvailable: true } },
        },
        orderBy: [{ isAvailable: 'desc' }, { pricePaise: 'asc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);
    const items = await Promise.all(
      products.map(async (p) => ({
        ...(await this.products.toDto(p)),
        vendor: { id: p.vendor.id, businessName: p.vendor.businessName, isAvailable: p.vendor.isAvailable, distanceMeters: distance.get(p.vendor.id) ?? null },
      })),
    );
    return paginated(items, total, q);
  }

  /** Public vendor details. The phone number is NOT here: it is revealed via POST /calls (ADR-009). */
  async vendorDetails(vendorId: string, point?: { lat: number; lng: number }) {
    const vendor = await this.prisma.vendorProfile.findFirst({
      where: { id: vendorId, approvalStatus: 'APPROVED', deletedAt: null, user: { status: 'ACTIVE' } },
    });
    if (!vendor) throw new NotFoundException('This seller is not available.');
    const view = await this.vendors.ownerView(vendor);
    let distanceMeters: number | null = null;
    if (point) {
      assertInIndia(point.lat, point.lng);
      const [row] = await this.prisma.$queryRaw<{ d: number }[]>`
        SELECT ST_Distance(location, ST_SetSRID(ST_MakePoint(${point.lng}, ${point.lat}), 4326)::geography) AS d
        FROM vendor_locations WHERE vendor_id = ${vendor.id}::uuid`;
      distanceMeters = row ? Math.round(Number(row.d)) : null;
    }
    const products = await this.prisma.vendorProduct.findMany({
      where: { vendorId: vendor.id, deletedAt: null, moderationStatus: 'ACTIVE' },
      include: { category: true, unit: true, image: { select: { storageKey: true, status: true } } },
      orderBy: [{ category: { sortOrder: 'asc' } }, { pricePaise: 'asc' }],
    });
    return {
      id: view.id,
      businessName: view.businessName,
      ownerName: view.ownerName,
      description: view.description,
      isAvailable: view.isAvailable,
      operatingHours: view.operatingHours,
      profilePhotoUrl: view.profilePhotoUrl,
      shopPhotoUrl: view.shopPhotoUrl,
      address: view.location
        ? {
            addressLine: view.location.addressLine,
            locality: view.location.locality,
            city: view.location.city,
            district: view.location.district,
            state: view.location.state,
            pincode: view.location.pincode,
            lat: view.location.lat,
            lng: view.location.lng,
          }
        : null,
      serviceAreas: view.serviceAreas,
      distanceMeters,
      canChat: true,
      canCall: Boolean(vendor.contactPhone),
      products: await Promise.all(products.map((p) => this.products.toDto(p))),
    };
  }
}

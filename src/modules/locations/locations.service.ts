import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { assertInIndia, PINCODE_RE } from './geo';
import { GeocodingProvider, PincodeProvider, PostOfficeRecord } from './providers';

export interface LocationSuggestion {
  name: string;
  pincode: string;
  district: string;
  state: string;
  label: string;
}

const FOUND_TTL_MS = 30 * 86_400_000;
const NOT_FOUND_TTL_MS = 86_400_000;

function toSuggestion(o: { name: string; pincode: string; district: string; state: string }): LocationSuggestion {
  return {
    name: o.name,
    pincode: o.pincode,
    district: o.district,
    state: o.state,
    label: `${o.name}, ${o.district}, ${o.state} - ${o.pincode}`,
  };
}

@Injectable()
export class LocationsService {
  private readonly logger = new Logger(LocationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pincodes: PincodeProvider,
    private readonly geocoder: GeocodingProvider,
  ) {}

  /** 6 digits → PIN lookup, otherwise post office / area name lookup (min 3 chars). */
  async search(rawQuery: string): Promise<LocationSuggestion[]> {
    const q = rawQuery.trim().replace(/\s+/g, ' ');
    if (PINCODE_RE.test(q)) return (await this.byPincode(q)).map(toSuggestion);
    if (/^\d+$/.test(q)) {
      throw new BadRequestException({ message: 'Enter a 6-digit PIN code.', errors: { q: ['PIN code must be 6 digits'] } });
    }
    if (q.length < 3) {
      throw new BadRequestException({ message: 'Type at least 3 letters.', errors: { q: ['Minimum 3 characters'] } });
    }
    return (await this.byName(q)).map(toSuggestion);
  }

  async byPincode(pin: string): Promise<PostOfficeRecord[]> {
    if (!PINCODE_RE.test(pin)) {
      throw new BadRequestException({ message: 'Enter a valid 6-digit PIN code.', errors: { pincode: ['Invalid PIN code'] } });
    }
    return this.cached(pin, () => this.pincodes.byPincode(pin), () =>
      this.prisma.postOffice.findMany({ where: { pincode: pin }, orderBy: { name: 'asc' }, take: 50 }),
    );
  }

  private async byName(name: string): Promise<PostOfficeRecord[]> {
    const key = `name:${name.toLowerCase()}`.slice(0, 120);
    const fromDb = () =>
      this.prisma.$queryRaw<PostOfficeRecord[]>`
        SELECT name, pincode, branch_type AS "branchType", delivery_status AS "deliveryStatus", circle,
               district, division, region, state, country
        FROM post_offices
        WHERE name ILIKE ${`%${name}%`} OR similarity(name, ${name}) > 0.35
        ORDER BY similarity(name, ${name}) DESC, name
        LIMIT 20`;
    return this.cached(key, () => this.pincodes.byBranchName(name), fromDb);
  }

  /**
   * Cache-first: a fresh lookup answers from our DB; otherwise call India Post and upsert.
   * If India Post is down, fall back to whatever we already have.
   */
  private async cached(
    key: string,
    fetchRemote: () => Promise<PostOfficeRecord[]>,
    readLocal: () => Promise<PostOfficeRecord[]>,
  ): Promise<PostOfficeRecord[]> {
    const lookup = await this.prisma.pincodeLookup.findUnique({ where: { key } });
    if (lookup) {
      const age = Date.now() - lookup.fetchedAt.getTime();
      const ttl = lookup.status === 'FOUND' ? FOUND_TTL_MS : NOT_FOUND_TTL_MS;
      if (age < ttl) return lookup.status === 'FOUND' ? (await readLocal()).slice(0, 20) : [];
    }

    let records: PostOfficeRecord[];
    try {
      records = await fetchRemote();
    } catch (error) {
      const local = await readLocal();
      if (local.length) return local.slice(0, 20);
      throw error instanceof ServiceUnavailableException
        ? error
        : new ServiceUnavailableException('PIN code search is temporarily unavailable. Please use your current location.');
    }

    for (const r of records) {
      await this.prisma.postOffice.upsert({
        where: { name_pincode: { name: r.name, pincode: r.pincode } },
        update: { ...r, fetchedAt: new Date() },
        create: r,
      });
    }
    const status = records.length ? 'FOUND' : 'NOT_FOUND';
    await this.prisma.pincodeLookup.upsert({
      where: { key },
      update: { status, fetchedAt: new Date() },
      create: { key, status },
    });
    return records.slice(0, 20);
  }

  /** Details for one PIN (vendor address autofill). */
  async pincodeDetails(pin: string) {
    const offices = await this.byPincode(pin);
    if (!offices.length) {
      throw new BadRequestException({ message: 'We could not find this PIN code.', errors: { pincode: ['PIN code not found'] } });
    }
    return {
      pincode: pin,
      district: offices[0].district,
      state: offices[0].state,
      postOffices: offices.map((o) => ({ name: o.name, branchType: o.branchType, deliveryStatus: o.deliveryStatus })),
    };
  }

  /** GPS → locality + PIN. Nominatim first; falls back to the nearest known post office / vendor. */
  async reverse(lat: number, lng: number) {
    assertInIndia(lat, lng);
    const geo = await this.geocoder.reverse(lat, lng);
    let pincode = geo?.pincode ?? null;
    let locality = geo?.locality ?? null;
    let district = geo?.district ?? null;
    let state = geo?.state ?? null;
    const city = geo?.city ?? null;

    if (!pincode) {
      const [near] = await this.prisma.$queryRaw<{ pincode: string; name: string; district: string; state: string }[]>`
        SELECT pincode, name, district, state FROM post_offices
        WHERE location IS NOT NULL
        ORDER BY location <-> ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
        LIMIT 1`;
      if (near) {
        pincode = near.pincode;
        locality = locality ?? near.name;
        district = district ?? near.district;
        state = state ?? near.state;
      }
    }

    if (pincode) {
      try {
        const offices = await this.byPincode(pincode);
        if (offices[0]) {
          district = offices[0].district;
          state = offices[0].state;
          locality = locality ?? offices[0].name;
          // Our cache has no coordinates; remember one for this PIN so KNN fallback improves over time.
          await this.prisma.$executeRaw`
            UPDATE post_offices SET location = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
            WHERE pincode = ${pincode} AND location IS NULL AND name = ${offices[0].name}`;
        }
      } catch (error) {
        this.logger.warn(`PIN enrich failed: ${(error as Error).message}`);
      }
    }

    const parts = [locality, city && city !== locality ? city : null].filter(Boolean);
    const label = parts.length
      ? `${parts.join(', ')}${pincode ? ` - ${pincode}` : ''}`
      : pincode
        ? `PIN ${pincode}`
        : 'Current location';
    return { lat, lng, label, locality, city, district, state, pincode };
  }

  /** An approximate point for a PIN we have coordinates for (used when a customer picks a PIN manually). */
  async centroidForPincode(pin: string): Promise<{ lat: number; lng: number } | null> {
    const [row] = await this.prisma.$queryRaw<{ lat: number; lng: number }[]>`
      SELECT ST_Y(c::geometry) AS lat, ST_X(c::geometry) AS lng FROM (
        SELECT ST_Centroid(ST_Collect(location::geometry))::geography AS c FROM (
          SELECT location FROM post_offices WHERE pincode = ${pin} AND location IS NOT NULL
          UNION ALL
          SELECT location FROM vendor_locations WHERE pincode = ${pin}
        ) pts
      ) x WHERE c IS NOT NULL`;
    return row ? { lat: Number(row.lat), lng: Number(row.lng) } : null;
  }
}

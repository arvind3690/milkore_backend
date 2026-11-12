import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.service';
import { roundCoord } from '../../common/utils/mask';

export interface PostOfficeRecord {
  name: string;
  pincode: string;
  branchType: string | null;
  deliveryStatus: string | null;
  circle: string | null;
  district: string;
  division: string | null;
  region: string | null;
  state: string;
  country: string;
}

export abstract class PincodeProvider {
  /** Empty array = not found. Throws ServiceUnavailableException when the source is down. */
  abstract byPincode(pin: string): Promise<PostOfficeRecord[]>;
  abstract byBranchName(name: string): Promise<PostOfficeRecord[]>;
}

export interface ReverseGeocodeResult {
  pincode: string | null;
  locality: string | null;
  city: string | null;
  district: string | null;
  state: string | null;
}

export abstract class GeocodingProvider {
  abstract reverse(lat: number, lng: number): Promise<ReverseGeocodeResult | null>;
}

/** Opens after 5 consecutive failures, for 60 s. Keeps a down API from slowing every request. */
export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;

  constructor(private readonly threshold = 5, private readonly coolDownMs = 60_000) {}

  get isOpen(): boolean {
    return Date.now() < this.openUntil;
  }

  success(): void {
    this.failures = 0;
  }

  failure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.openUntil = Date.now() + this.coolDownMs;
      this.failures = 0;
    }
  }
}

const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .trim();

/** Parses the India Post response: `[{ Status, Message, PostOffice: [...] | null }]`. */
export function parseIndiaPostResponse(body: unknown, fallbackPin?: string): PostOfficeRecord[] {
  const first = Array.isArray(body) ? body[0] : body;
  if (!first || typeof first !== 'object') throw new Error('Unexpected India Post response');
  const { Status, PostOffice } = first as { Status?: string; PostOffice?: unknown };
  if (String(Status).toLowerCase() !== 'success' || !Array.isArray(PostOffice)) return [];
  return PostOffice.flatMap((raw): PostOfficeRecord[] => {
    if (!raw || typeof raw !== 'object') return [];
    const o = raw as Record<string, unknown>;
    const pin = String(o.PINCode ?? o.Pincode ?? fallbackPin ?? '').trim();
    const name = String(o.Name ?? '').trim();
    if (!/^[1-9]\d{5}$/.test(pin) || !name) return [];
    const str = (v: unknown) => (typeof v === 'string' && v.trim() && v.trim() !== 'NA' ? v.trim() : null);
    return [
      {
        name: titleCase(name).slice(0, 120),
        pincode: pin,
        branchType: str(o.BranchType),
        deliveryStatus: str(o.DeliveryStatus),
        circle: str(o.Circle),
        district: titleCase(str(o.District) ?? '').slice(0, 80) || 'Unknown',
        division: str(o.Division),
        region: str(o.Region),
        state: titleCase(str(o.State) ?? '').slice(0, 80) || 'Unknown',
        country: str(o.Country) ?? 'India',
      },
    ];
  });
}

/** https://api.postalpincode.in (free, no key). Backend-only; results are cached by LocationsService. */
@Injectable()
export class IndiaPostPincodeProvider extends PincodeProvider {
  private readonly logger = new Logger('IndiaPost');
  private readonly breaker = new CircuitBreaker();

  constructor(private readonly config: AppConfig) {
    super();
  }

  byPincode(pin: string) {
    return this.call(`/pincode/${pin}`, pin);
  }

  byBranchName(name: string) {
    return this.call(`/postoffice/${encodeURIComponent(name)}`);
  }

  private async call(path: string, pin?: string): Promise<PostOfficeRecord[]> {
    if (this.breaker.isOpen) throw new ServiceUnavailableException('PIN code search is temporarily unavailable.');
    const url = `${this.config.get('PINCODE_API_URL')}${path}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const records = parseIndiaPostResponse(await res.json(), pin);
        this.breaker.success();
        return records;
      } catch (error) {
        this.logger.warn(`India Post call failed (attempt ${attempt + 1}): ${(error as Error).message}`);
      }
    }
    this.breaker.failure();
    throw new ServiceUnavailableException(
      'PIN code search is temporarily unavailable. Please use your current location.',
    );
  }
}

/**
 * OpenStreetMap Nominatim reverse geocoding. Usage policy: max 1 request/second,
 * identifying User-Agent, cache results. Coordinates are cached rounded to ~110 m.
 */
@Injectable()
export class NominatimGeocodingProvider extends GeocodingProvider {
  private readonly logger = new Logger('Nominatim');
  private readonly breaker = new CircuitBreaker(3, 120_000);
  private readonly cache = new Map<string, ReverseGeocodeResult | null>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastCallAt = 0;

  constructor(private readonly config: AppConfig) {
    super();
  }

  async reverse(lat: number, lng: number): Promise<ReverseGeocodeResult | null> {
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    if (this.breaker.isOpen) return null;

    const run = async () => {
      const wait = 1100 - (Date.now() - this.lastCallAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCallAt = Date.now();
      const url = new URL('/reverse', this.config.get('NOMINATIM_URL'));
      url.search = new URLSearchParams({
        format: 'jsonv2',
        lat: String(lat),
        lon: String(lng),
        zoom: '16',
        addressdetails: '1',
      }).toString();
      const res = await fetch(url, {
        headers: { 'user-agent': this.config.get('GEOCODER_USER_AGENT'), 'accept-language': 'en' },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { address?: Record<string, string> };
    };

    try {
      const job = this.queue.then(run, run);
      this.queue = job.catch(() => undefined);
      const body = await job;
      const a = body.address ?? {};
      const postcode = (a.postcode ?? '').replace(/\s/g, '');
      const result: ReverseGeocodeResult = {
        pincode: /^[1-9]\d{5}$/.test(postcode) ? postcode : null,
        locality: a.suburb ?? a.neighbourhood ?? a.quarter ?? a.village ?? a.hamlet ?? a.town ?? null,
        city: a.city ?? a.town ?? a.village ?? a.county ?? null,
        district: a.state_district ?? a.county ?? null,
        state: a.state ?? null,
      };
      this.breaker.success();
      if (this.cache.size > 5000) this.cache.clear();
      this.cache.set(key, result);
      return result;
    } catch (error) {
      this.breaker.failure();
      this.logger.warn(`reverse failed near ${roundCoord(lat)},${roundCoord(lng)}: ${(error as Error).message}`);
      return null;
    }
  }
}

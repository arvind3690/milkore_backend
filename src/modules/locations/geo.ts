import { BadRequestException } from '@nestjs/common';

/** Generous bounding box for India (incl. islands). */
export const INDIA_BOUNDS = { minLat: 6, maxLat: 37.6, minLng: 68, maxLng: 97.5 };

export function assertInIndia(lat: number, lng: number): void {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < INDIA_BOUNDS.minLat ||
    lat > INDIA_BOUNDS.maxLat ||
    lng < INDIA_BOUNDS.minLng ||
    lng > INDIA_BOUNDS.maxLng
  ) {
    throw new BadRequestException({
      message: 'This location is outside India.',
      errors: { location: ['Location must be inside India'] },
    });
  }
}

export const PINCODE_RE = /^[1-9]\d{5}$/;

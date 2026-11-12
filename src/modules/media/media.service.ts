import { randomUUID } from 'node:crypto';
import { BadRequestException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { MediaAsset, MediaPurpose } from '@prisma/client';
import sharp from 'sharp';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageProvider } from './storage.provider';

export const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_DIMENSION = 1280;

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    readonly storage: StorageProvider,
  ) {}

  async createUpload(userId: string, purpose: MediaPurpose, mimeType: string, sizeBytes: number) {
    if (!ALLOWED_MIME.includes(mimeType as (typeof ALLOWED_MIME)[number])) {
      throw new BadRequestException({ message: 'Only JPG, PNG or WEBP photos are allowed.', errors: { mimeType: ['Unsupported image type'] } });
    }
    if (sizeBytes <= 0 || sizeBytes > MAX_UPLOAD_BYTES) {
      throw new BadRequestException({ message: 'Photo must be smaller than 5 MB.', errors: { sizeBytes: ['Maximum 5 MB'] } });
    }
    const recent = await this.prisma.mediaAsset.count({
      where: { ownerUserId: userId, createdAt: { gte: new Date(Date.now() - 3_600_000) } },
    });
    if (recent >= 60) throw new HttpException('Too many uploads. Please try again later.', HttpStatus.TOO_MANY_REQUESTS);

    const id = randomUUID();
    const key = `media/${purpose.toLowerCase()}/${userId}/${id}.${EXT[mimeType]}`;
    await this.prisma.mediaAsset.create({
      data: { id, ownerUserId: userId, purpose, storageKey: key, mimeType, sizeBytes },
    });
    const target = await this.storage.createUpload(id, key, mimeType, sizeBytes);
    return { mediaId: id, ...target };
  }

  /**
   * Validates the uploaded bytes are a real image, auto-rotates, resizes to ≤1280px and
   * re-encodes (which strips EXIF, including GPS), then marks the asset READY.
   */
  async confirm(userId: string, mediaId: string) {
    const asset = await this.prisma.mediaAsset.findFirst({ where: { id: mediaId, ownerUserId: userId } });
    if (!asset) throw new NotFoundException('Photo not found.');
    if (asset.status === 'READY') return this.toDto(asset);

    const bytes = await this.storage.read(asset.storageKey);
    if (!bytes) throw new BadRequestException('The photo has not been uploaded yet.');
    if (bytes.length > MAX_UPLOAD_BYTES) {
      await this.reject(asset.id);
      throw new BadRequestException('Photo must be smaller than 5 MB.');
    }

    let processed: { data: Buffer; info: sharp.OutputInfo };
    try {
      const meta = await sharp(bytes).metadata();
      if (!meta.format || !['jpeg', 'png', 'webp'].includes(meta.format)) throw new Error('format');
      const pipeline = sharp(bytes)
        .rotate()
        .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true });
      const encoded =
        asset.mimeType === 'image/png'
          ? pipeline.png({ compressionLevel: 9 })
          : asset.mimeType === 'image/webp'
            ? pipeline.webp({ quality: 80 })
            : pipeline.jpeg({ quality: 80, mozjpeg: true });
      processed = await encoded.toBuffer({ resolveWithObject: true });
    } catch {
      await this.reject(asset.id);
      throw new BadRequestException('This file is not a valid photo.');
    }

    await this.storage.write(asset.storageKey, processed.data, asset.mimeType);
    const updated = await this.prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        status: 'READY',
        sizeBytes: processed.data.length,
        width: processed.info.width,
        height: processed.info.height,
      },
    });
    return this.toDto(updated);
  }

  private async reject(id: string) {
    await this.prisma.mediaAsset.update({ where: { id }, data: { status: 'REJECTED' } });
  }

  /** Ensures a READY asset owned by the user, for the given purpose. */
  async requireReady(userId: string, mediaId: string, purpose: MediaPurpose): Promise<MediaAsset> {
    const asset = await this.prisma.mediaAsset.findFirst({ where: { id: mediaId, ownerUserId: userId } });
    if (!asset || asset.status !== 'READY' || asset.purpose !== purpose) {
      throw new BadRequestException({ message: 'Please upload the photo again.', errors: { photo: ['Photo is not ready'] } });
    }
    return asset;
  }

  async url(key: string | null | undefined): Promise<string | null> {
    return key ? this.storage.publicUrl(key) : null;
  }

  async urlForId(id: string | null | undefined): Promise<string | null> {
    if (!id) return null;
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id }, select: { storageKey: true, status: true } });
    return asset?.status === 'READY' ? this.storage.publicUrl(asset.storageKey) : null;
  }

  async toDto(asset: MediaAsset) {
    return {
      id: asset.id,
      purpose: asset.purpose,
      status: asset.status,
      width: asset.width,
      height: asset.height,
      url: asset.status === 'READY' ? await this.storage.publicUrl(asset.storageKey) : null,
    };
  }
}

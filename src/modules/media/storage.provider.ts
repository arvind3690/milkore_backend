import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.service';

export interface UploadTarget {
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresInSeconds: number;
}

/**
 * Where image bytes live. URLs returned by the local provider are relative (`/api/v1/...`);
 * the app resolves them against its API base URL, so emulators and phones both work.
 */
export abstract class StorageProvider {
  abstract createUpload(id: string, key: string, mimeType: string, sizeBytes: number): Promise<UploadTarget>;
  abstract read(key: string): Promise<Buffer | null>;
  abstract write(key: string, body: Buffer, mimeType: string): Promise<void>;
  abstract publicUrl(key: string): Promise<string>;
}

export const UPLOAD_TTL_SECONDS = 300;

@Injectable()
export class LocalStorageProvider extends StorageProvider {
  readonly root = resolve(process.cwd(), 'uploads');

  constructor(private readonly config: AppConfig) {
    super();
  }

  private sign(id: string, exp: number): string {
    return createHmac('sha256', this.config.get('JWT_SECRET')).update(`upload:${id}:${exp}`).digest('hex');
  }

  verifySignature(id: string, exp: number, sig: string): boolean {
    if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
    const a = Buffer.from(this.sign(id, exp), 'hex');
    const b = Buffer.from(sig ?? '', 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Resolves a storage key to a path inside `uploads/`, refusing traversal. */
  pathFor(key: string): string | null {
    const full = resolve(this.root, key);
    return full.startsWith(this.root + sep) ? full : null;
  }

  async createUpload(id: string, _key: string, mimeType: string): Promise<UploadTarget> {
    const exp = Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS;
    return {
      uploadUrl: `/api/v1/media/local-upload/${id}?exp=${exp}&sig=${this.sign(id, exp)}`,
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      expiresInSeconds: UPLOAD_TTL_SECONDS,
    };
  }

  async read(key: string): Promise<Buffer | null> {
    const path = this.pathFor(key);
    if (!path) return null;
    try {
      await stat(path);
      return await readFile(path);
    } catch {
      return null;
    }
  }

  async write(key: string, body: Buffer): Promise<void> {
    const path = this.pathFor(key);
    if (!path) throw new Error('Invalid storage key');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async publicUrl(key: string): Promise<string> {
    return `/api/v1/media/files/${key}`;
  }
}

@Injectable()
export class S3StorageProvider extends StorageProvider {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: AppConfig) {
    super();
    const accessKeyId = config.get('AWS_ACCESS_KEY_ID');
    const secretAccessKey = config.get('AWS_SECRET_ACCESS_KEY');
    this.s3 = new S3Client({
      region: config.get('AWS_REGION'),
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    });
    this.bucket = config.get('S3_BUCKET') ?? '';
  }

  async createUpload(_id: string, key: string, mimeType: string, sizeBytes: number): Promise<UploadTarget> {
    const uploadUrl = await getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: mimeType, ContentLength: sizeBytes }),
      { expiresIn: UPLOAD_TTL_SECONDS },
    );
    return { uploadUrl, method: 'PUT', headers: { 'Content-Type': mimeType }, expiresInSeconds: UPLOAD_TTL_SECONDS };
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await out.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : null;
    } catch {
      return null;
    }
  }

  async write(key: string, body: Buffer, mimeType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: mimeType,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
  }

  async publicUrl(key: string): Promise<string> {
    const base = this.config.get('MEDIA_PUBLIC_BASE_URL');
    if (base) return `${base.replace(/\/$/, '')}/${key}`;
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: 3600 });
  }
}

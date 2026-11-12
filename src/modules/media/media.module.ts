import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { MediaPurpose } from '@prisma/client';
import { IsEnum, IsIn, IsInt, Max, Min } from 'class-validator';
import type { Request, Response } from 'express';
import { AuthUser, CurrentUser } from '../../common/auth/auth.types';
import { Public, RawResponse, ResponseMessage } from '../../common/decorators';
import { AppConfig } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ALLOWED_MIME, MAX_UPLOAD_BYTES, MediaService } from './media.service';
import { LocalStorageProvider, S3StorageProvider, StorageProvider } from './storage.provider';

class UploadUrlDto {
  @ApiProperty({ enum: MediaPurpose }) @IsEnum(MediaPurpose) purpose: MediaPurpose;
  @ApiProperty({ enum: ALLOWED_MIME }) @IsIn([...ALLOWED_MIME]) mimeType: string;
  @ApiProperty({ example: 350000 }) @IsInt() @Min(1) @Max(MAX_UPLOAD_BYTES) sizeBytes: number;
}

@ApiTags('media')
@Controller('media')
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly prisma: PrismaService,
  ) {}

  @ApiBearerAuth()
  @Post('upload-url')
  @ResponseMessage('Upload ready')
  uploadUrl(@CurrentUser() user: AuthUser, @Body() dto: UploadUrlDto) {
    return this.media.createUpload(user.id, dto.purpose, dto.mimeType, dto.sizeBytes);
  }

  @ApiBearerAuth()
  @Post(':id/confirm')
  @ResponseMessage('Photo saved')
  confirm(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.media.confirm(user.id, id);
  }

  /** Development storage only: target of the signed upload URL (body is the raw image). */
  @Public()
  @Put('local-upload/:id')
  @ResponseMessage('Uploaded')
  async localUpload(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Req() req: Request,
  ) {
    const storage = this.media.storage;
    if (!(storage instanceof LocalStorageProvider)) throw new NotFoundException();
    if (!storage.verifySignature(id, Number(exp), sig)) throw new ForbiddenException('Upload link expired.');
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset || asset.status !== 'PENDING_UPLOAD') throw new NotFoundException('Upload not found.');
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body) || body.length === 0) throw new BadRequestException('Empty upload.');
    if (body.length > MAX_UPLOAD_BYTES) throw new BadRequestException('Photo must be smaller than 5 MB.');
    await storage.write(asset.storageKey, body);
    return null;
  }

  /** Development storage only: serves processed images. */
  @Public()
  @RawResponse()
  @Get('files/*path')
  async file(@Param('path') path: string | string[], @Res() res: Response) {
    const storage = this.media.storage;
    const key = Array.isArray(path) ? path.join('/') : path;
    if (!(storage instanceof LocalStorageProvider)) throw new NotFoundException();
    const asset = await this.prisma.mediaAsset.findUnique({ where: { storageKey: key } });
    const full = storage.pathFor(key);
    if (!asset || asset.status !== 'READY' || !full) throw new NotFoundException('Photo not found.');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type(asset.mimeType).sendFile(full);
  }
}

@Module({
  controllers: [MediaController],
  providers: [
    MediaService,
    {
      provide: StorageProvider,
      inject: [AppConfig],
      useFactory: (c: AppConfig) =>
        c.get('STORAGE_PROVIDER') === 's3' ? new S3StorageProvider(c) : new LocalStorageProvider(c),
    },
  ],
  exports: [MediaService],
})
export class MediaModule {}

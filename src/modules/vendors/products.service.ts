import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ProductCategory, Unit, VendorProduct } from '@prisma/client';
import { formatRupees } from '../../common/utils/mask';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaService } from '../media/media.service';
import { VendorsService } from './vendors.service';

export const MAX_PRODUCTS_PER_VENDOR = 50;

type ProductWithRefs = VendorProduct & { category: ProductCategory; unit: Unit; image?: { storageKey: string; status: string } | null };

export interface ProductInput {
  categoryId: string;
  unitId: string;
  name: string;
  description?: string | null;
  imageId?: string | null;
  pricePaise: number;
  isAvailable?: boolean;
}

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vendors: VendorsService,
    private readonly media: MediaService,
  ) {}

  async toDto(p: ProductWithRefs) {
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      category: { id: p.category.id, slug: p.category.slug, nameEn: p.category.nameEn, nameHi: p.category.nameHi, iconKey: p.category.iconKey },
      unit: { id: p.unit.id, code: p.unit.code, labelEn: p.unit.labelEn, labelHi: p.unit.labelHi },
      pricePaise: p.pricePaise,
      priceDisplay: `${formatRupees(p.pricePaise)} / ${p.unit.labelEn}`,
      priceDisplayHi: `${formatRupees(p.pricePaise)} / ${p.unit.labelHi}`,
      isAvailable: p.isAvailable,
      moderationStatus: p.moderationStatus,
      removedReason: p.removedReason,
      imageId: p.imageId,
      imageUrl: p.image?.status === 'READY' ? await this.media.url(p.image.storageKey) : null,
      updatedAt: p.updatedAt,
    };
  }

  private readonly include = { category: true, unit: true, image: { select: { storageKey: true, status: true } } } as const;

  /** Ownership: every query is scoped by the vendor id from the JWT. Another vendor's id → 404. */
  private async owned(userId: string, productId: string) {
    const vendor = await this.vendors.findByUser(userId);
    const product = await this.prisma.vendorProduct.findFirst({
      where: { id: productId, vendorId: vendor.id, deletedAt: null },
      include: this.include,
    });
    if (!product) throw new NotFoundException('Product not found.');
    return { vendor, product };
  }

  private async validateRefs(input: Partial<ProductInput>, userId: string) {
    if (input.categoryId) {
      const c = await this.prisma.productCategory.findUnique({ where: { id: input.categoryId } });
      if (!c || !c.isActive) throw new BadRequestException({ message: 'Please choose a valid category.', errors: { categoryId: ['Unknown category'] } });
    }
    if (input.unitId) {
      const u = await this.prisma.unit.findUnique({ where: { id: input.unitId } });
      if (!u) throw new BadRequestException({ message: 'Please choose a valid unit.', errors: { unitId: ['Unknown unit'] } });
    }
    if (input.imageId) await this.media.requireReady(userId, input.imageId, 'PRODUCT');
  }

  async list(userId: string) {
    const vendor = await this.vendors.findByUser(userId);
    const items = await this.prisma.vendorProduct.findMany({
      where: { vendorId: vendor.id, deletedAt: null },
      include: this.include,
      orderBy: [{ category: { sortOrder: 'asc' } }, { createdAt: 'asc' }],
    });
    return Promise.all(items.map((p) => this.toDto(p)));
  }

  async get(userId: string, productId: string) {
    return this.toDto((await this.owned(userId, productId)).product);
  }

  async create(userId: string, input: ProductInput) {
    const vendor = await this.vendors.findByUser(userId);
    if (vendor.approvalStatus === 'SUSPENDED') throw new ConflictException('Your shop is suspended.');
    const count = await this.prisma.vendorProduct.count({ where: { vendorId: vendor.id, deletedAt: null } });
    if (count >= MAX_PRODUCTS_PER_VENDOR) {
      throw new ConflictException(`You can list up to ${MAX_PRODUCTS_PER_VENDOR} products.`);
    }
    await this.validateRefs(input, userId);
    const product = await this.prisma.vendorProduct.create({
      data: {
        vendorId: vendor.id,
        categoryId: input.categoryId,
        unitId: input.unitId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        imageId: input.imageId ?? null,
        pricePaise: input.pricePaise,
        isAvailable: input.isAvailable ?? true,
      },
      include: this.include,
    });
    return this.toDto(product);
  }

  async update(userId: string, productId: string, input: Partial<ProductInput>) {
    const { product } = await this.owned(userId, productId);
    if (product.moderationStatus === 'REMOVED_BY_ADMIN') {
      throw new ConflictException('This product was removed by Milkore and cannot be edited.');
    }
    await this.validateRefs(input, userId);
    const updated = await this.prisma.$transaction(async (tx) => {
      if (input.pricePaise !== undefined && input.pricePaise !== product.pricePaise) {
        await tx.priceHistory.create({
          data: { vendorProductId: product.id, oldPricePaise: product.pricePaise, newPricePaise: input.pricePaise },
        });
      }
      return tx.vendorProduct.update({
        where: { id: product.id },
        data: {
          ...(input.categoryId ? { categoryId: input.categoryId } : {}),
          ...(input.unitId ? { unitId: input.unitId } : {}),
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
          ...(input.imageId !== undefined ? { imageId: input.imageId } : {}),
          ...(input.pricePaise !== undefined ? { pricePaise: input.pricePaise } : {}),
          ...(input.isAvailable !== undefined ? { isAvailable: input.isAvailable } : {}),
        },
        include: this.include,
      });
    });
    return this.toDto(updated);
  }

  async remove(userId: string, productId: string) {
    const { product } = await this.owned(userId, productId);
    await this.prisma.vendorProduct.update({ where: { id: product.id }, data: { deletedAt: new Date(), imageId: null } });
    return null;
  }
}

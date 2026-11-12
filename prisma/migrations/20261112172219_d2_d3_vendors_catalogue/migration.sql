-- CreateEnum
CREATE TYPE "VendorApprovalStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ServiceAreaType" AS ENUM ('RADIUS', 'PINCODE', 'LOCALITY');

-- CreateEnum
CREATE TYPE "MediaPurpose" AS ENUM ('VENDOR_PROFILE', 'VENDOR_SHOP', 'PRODUCT');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('PENDING_UPLOAD', 'READY', 'REJECTED');

-- CreateEnum
CREATE TYPE "PincodeLookupStatus" AS ENUM ('FOUND', 'NOT_FOUND');

-- CreateEnum
CREATE TYPE "ModerationStatus" AS ENUM ('ACTIVE', 'REMOVED_BY_ADMIN');

-- CreateTable
CREATE TABLE "vendor_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "business_name" VARCHAR(100),
    "owner_name" VARCHAR(80),
    "description" VARCHAR(500),
    "operating_hours" JSONB,
    "approval_status" "VendorApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "rejection_reason" VARCHAR(300),
    "suspension_reason" VARCHAR(300),
    "onboarding_step" INTEGER NOT NULL DEFAULT 0,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "contact_phone" VARCHAR(16),
    "profile_photo_id" UUID,
    "shop_photo_id" UUID,
    "submitted_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "approved_by_admin_id" UUID,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_locations" (
    "id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "address_line" VARCHAR(200) NOT NULL,
    "locality" VARCHAR(100) NOT NULL,
    "city" VARCHAR(80) NOT NULL,
    "district" VARCHAR(80) NOT NULL,
    "state" VARCHAR(80) NOT NULL,
    "pincode" CHAR(6) NOT NULL,
    "location" geography(Point, 4326) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_service_areas" (
    "id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "type" "ServiceAreaType" NOT NULL,
    "radius_meters" INTEGER,
    "pincode" CHAR(6),
    "locality_name" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_service_areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_approval_history" (
    "id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "from_status" "VendorApprovalStatus" NOT NULL,
    "to_status" "VendorApprovalStatus" NOT NULL,
    "admin_id" UUID,
    "note" VARCHAR(300),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_approval_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "purpose" "MediaPurpose" NOT NULL,
    "storage_key" VARCHAR(200) NOT NULL,
    "mime_type" VARCHAR(40) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "status" "MediaStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_offices" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "pincode" CHAR(6) NOT NULL,
    "branch_type" VARCHAR(40),
    "delivery_status" VARCHAR(40),
    "circle" VARCHAR(80),
    "district" VARCHAR(80) NOT NULL,
    "division" VARCHAR(80),
    "region" VARCHAR(80),
    "state" VARCHAR(80) NOT NULL,
    "country" VARCHAR(40) NOT NULL DEFAULT 'India',
    "location" geography(Point, 4326),
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_offices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pincode_lookups" (
    "key" VARCHAR(120) NOT NULL,
    "status" "PincodeLookupStatus" NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pincode_lookups_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "product_categories" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(40) NOT NULL,
    "name_en" VARCHAR(60) NOT NULL,
    "name_hi" VARCHAR(60) NOT NULL,
    "icon_key" VARCHAR(40) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units" (
    "id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "label_en" VARCHAR(30) NOT NULL,
    "label_hi" VARCHAR(30) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_products" (
    "id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(300),
    "image_id" UUID,
    "price_paise" INTEGER NOT NULL,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "moderation_status" "ModerationStatus" NOT NULL DEFAULT 'ACTIVE',
    "removed_reason" VARCHAR(300),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_history" (
    "id" UUID NOT NULL,
    "vendor_product_id" UUID NOT NULL,
    "old_price_paise" INTEGER NOT NULL,
    "new_price_paise" INTEGER NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vendor_profiles_user_id_key" ON "vendor_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_profiles_profile_photo_id_key" ON "vendor_profiles"("profile_photo_id");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_profiles_shop_photo_id_key" ON "vendor_profiles"("shop_photo_id");

-- CreateIndex
CREATE INDEX "vendor_profiles_approval_status_idx" ON "vendor_profiles"("approval_status");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_locations_vendor_id_key" ON "vendor_locations"("vendor_id");

-- CreateIndex
CREATE INDEX "vendor_locations_location_idx" ON "vendor_locations" USING GIST ("location");

-- CreateIndex
CREATE INDEX "vendor_locations_pincode_idx" ON "vendor_locations"("pincode");

-- CreateIndex
CREATE INDEX "vendor_service_areas_vendor_id_idx" ON "vendor_service_areas"("vendor_id");

-- CreateIndex
CREATE INDEX "vendor_service_areas_pincode_idx" ON "vendor_service_areas"("pincode");

-- CreateIndex
CREATE INDEX "vendor_service_areas_locality_name_idx" ON "vendor_service_areas"("locality_name");

-- CreateIndex
CREATE INDEX "vendor_approval_history_vendor_id_created_at_idx" ON "vendor_approval_history"("vendor_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_storage_key_key" ON "media_assets"("storage_key");

-- CreateIndex
CREATE INDEX "media_assets_owner_user_id_idx" ON "media_assets"("owner_user_id");

-- CreateIndex
CREATE INDEX "post_offices_pincode_idx" ON "post_offices"("pincode");

-- CreateIndex
CREATE INDEX "post_offices_name_trgm_idx" ON "post_offices" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "post_offices_name_pincode_key" ON "post_offices"("name", "pincode");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_slug_key" ON "product_categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "units_code_key" ON "units"("code");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_products_image_id_key" ON "vendor_products"("image_id");

-- CreateIndex
CREATE INDEX "vendor_products_vendor_id_idx" ON "vendor_products"("vendor_id");

-- CreateIndex
CREATE INDEX "vendor_products_category_id_is_available_idx" ON "vendor_products"("category_id", "is_available");

-- CreateIndex
CREATE INDEX "price_history_vendor_product_id_changed_at_idx" ON "price_history"("vendor_product_id", "changed_at");

-- AddForeignKey
ALTER TABLE "vendor_profiles" ADD CONSTRAINT "vendor_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_profiles" ADD CONSTRAINT "vendor_profiles_profile_photo_id_fkey" FOREIGN KEY ("profile_photo_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_profiles" ADD CONSTRAINT "vendor_profiles_shop_photo_id_fkey" FOREIGN KEY ("shop_photo_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_locations" ADD CONSTRAINT "vendor_locations_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_service_areas" ADD CONSTRAINT "vendor_service_areas_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_approval_history" ADD CONSTRAINT "vendor_approval_history_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_products" ADD CONSTRAINT "vendor_products_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_products" ADD CONSTRAINT "vendor_products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "product_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_products" ADD CONSTRAINT "vendor_products_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_products" ADD CONSTRAINT "vendor_products_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_vendor_product_id_fkey" FOREIGN KEY ("vendor_product_id") REFERENCES "vendor_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Manual CHECK constraints (Prisma does not model these; it never drops them)
ALTER TABLE "vendor_locations" ADD CONSTRAINT "vendor_locations_pincode_chk" CHECK ("pincode" ~ '^[1-9][0-9]{5}$');
ALTER TABLE "vendor_service_areas" ADD CONSTRAINT "vendor_service_areas_radius_chk" CHECK ("radius_meters" IS NULL OR "radius_meters" BETWEEN 500 AND 20000);
ALTER TABLE "vendor_service_areas" ADD CONSTRAINT "vendor_service_areas_pincode_chk" CHECK ("pincode" IS NULL OR "pincode" ~ '^[1-9][0-9]{5}$');
ALTER TABLE "vendor_service_areas" ADD CONSTRAINT "vendor_service_areas_shape_chk" CHECK (
  ("type" = 'RADIUS' AND "radius_meters" IS NOT NULL) OR
  ("type" = 'PINCODE' AND "pincode" IS NOT NULL) OR
  ("type" = 'LOCALITY' AND "locality_name" IS NOT NULL));
ALTER TABLE "post_offices" ADD CONSTRAINT "post_offices_pincode_chk" CHECK ("pincode" ~ '^[1-9][0-9]{5}$');
ALTER TABLE "vendor_products" ADD CONSTRAINT "vendor_products_price_chk" CHECK ("price_paise" BETWEEN 100 AND 10000000);

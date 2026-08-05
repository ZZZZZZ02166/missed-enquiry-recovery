-- CreateEnum
CREATE TYPE "pricing_type" AS ENUM ('FIXED', 'STARTING_FROM', 'PER_UNIT', 'MANUAL_QUOTE');

-- CreateEnum
CREATE TYPE "price_confidence" AS ENUM ('FIRM', 'ESTIMATE');

-- CreateEnum
CREATE TYPE "service_availability" AS ENUM ('ACTIVE', 'DISABLED', 'TEMPORARILY_UNAVAILABLE');

-- CreateTable
CREATE TABLE "services" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "aliases" TEXT[],
    "pricing_type" "pricing_type" NOT NULL,
    "price_cents" INTEGER,
    "unit_label" TEXT,
    "min_units" INTEGER,
    "max_units" INTEGER,
    "show_price_automatically" BOOLEAN NOT NULL DEFAULT true,
    "price_confidence" "price_confidence" NOT NULL DEFAULT 'ESTIMATE',
    "requires_confirmation" BOOLEAN NOT NULL DEFAULT true,
    "required_fields" TEXT[],
    "questions" JSONB,
    "availability" "service_availability" NOT NULL DEFAULT 'ACTIVE',
    "pricing_rules" JSONB,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "services_business_id_availability_sort_order_idx" ON "services"("business_id", "availability", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "services_business_id_name_key" ON "services"("business_id", "name");

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

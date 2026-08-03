-- CreateEnum
CREATE TYPE "lead_status" AS ENUM ('NEW', 'QUALIFYING', 'QUALIFIED', 'QUOTED', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "property_type" AS ENUM ('HOUSE', 'APARTMENT', 'TOWNHOUSE', 'UNIT', 'OTHER');

-- CreateEnum
CREATE TYPE "lead_urgency" AS ENUM ('LOW', 'NORMAL', 'HIGH');

-- CreateEnum
CREATE TYPE "quote_type" AS ENUM ('FIXED', 'ESTIMATE', 'FROM', 'NONE');

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "status" "lead_status" NOT NULL DEFAULT 'NEW',
    "needs_human" BOOLEAN NOT NULL DEFAULT false,
    "is_spam" BOOLEAN NOT NULL DEFAULT false,
    "is_duplicate" BOOLEAN NOT NULL DEFAULT false,
    "opted_out" BOOLEAN NOT NULL DEFAULT false,
    "needs_human_reason" TEXT,
    "lost_reason" TEXT,
    "service_type" TEXT,
    "service_id" TEXT,
    "suburb" TEXT,
    "property_type" "property_type",
    "bedrooms" INTEGER,
    "bathrooms" INTEGER,
    "carpeted_rooms" INTEGER,
    "preferred_date" TEXT,
    "urgency" "lead_urgency",
    "property_condition" TEXT,
    "extras" JSONB,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "missing_fields" TEXT[],
    "quoted_amount_cents" INTEGER,
    "quote_type" "quote_type" NOT NULL DEFAULT 'NONE',
    "quote_shown_to_customer" BOOLEAN NOT NULL DEFAULT false,
    "quoted_at" TIMESTAMP(3),
    "quote_snapshot" JSONB,
    "owner_notified_at" TIMESTAMP(3),
    "won_value_cents" INTEGER,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "leads_conversation_id_key" ON "leads"("conversation_id");

-- CreateIndex
CREATE INDEX "leads_business_id_status_created_at_idx" ON "leads"("business_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "leads_business_id_created_at_idx" ON "leads"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "leads_business_id_suburb_idx" ON "leads"("business_id", "suburb");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

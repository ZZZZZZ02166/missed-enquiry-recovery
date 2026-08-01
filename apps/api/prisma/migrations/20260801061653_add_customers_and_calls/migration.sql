-- CreateEnum
CREATE TYPE "line_type" AS ENUM ('UNKNOWN', 'MOBILE', 'LANDLINE', 'VOIP', 'TOLL_FREE', 'OTHER');

-- CreateEnum
CREATE TYPE "call_outcome" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "no_recovery_reason" AS ENUM ('ANONYMOUS_CALLER', 'NOT_TEXTABLE', 'SUPPRESSED', 'RECENTLY_CONTACTED', 'KNOWN_CONTACT', 'CAP_REACHED', 'ANSWERED');

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "lineType" "line_type" NOT NULL DEFAULT 'UNKNOWN',
    "line_type_at" TIMESTAMP(3),
    "is_known_contact" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calls" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "provider_call_sid" TEXT NOT NULL,
    "from_e164" TEXT,
    "to_e164" TEXT NOT NULL,
    "forwarded_from_e164" TEXT,
    "outcome" "call_outcome" NOT NULL DEFAULT 'IN_PROGRESS',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "duration_seconds" INTEGER,
    "recovery_sms_queued_at" TIMESTAMP(3),
    "no_recovery_reason" "no_recovery_reason",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_business_id_created_at_idx" ON "customers"("business_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "customers_business_id_phone_e164_key" ON "customers"("business_id", "phone_e164");

-- CreateIndex
CREATE UNIQUE INDEX "calls_provider_call_sid_key" ON "calls"("provider_call_sid");

-- CreateIndex
CREATE INDEX "calls_business_id_started_at_idx" ON "calls"("business_id", "started_at");

-- CreateIndex
CREATE INDEX "calls_business_id_no_recovery_reason_idx" ON "calls"("business_id", "no_recovery_reason");

-- CreateIndex
CREATE INDEX "calls_customer_id_idx" ON "calls"("customer_id");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "phone_number_purpose" AS ENUM ('VOICE_INBOUND', 'SMS_TWO_WAY');

-- CreateEnum
CREATE TYPE "phone_number_status" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'RELEASED');

-- CreateTable
CREATE TABLE "phone_numbers" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "e164" TEXT NOT NULL,
    "twilio_sid" TEXT,
    "purpose" "phone_number_purpose" NOT NULL,
    "status" "phone_number_status" NOT NULL DEFAULT 'PENDING',
    "status_changed_at" TIMESTAMP(3),
    "forwards_from_e164" TEXT,
    "forwarding_carrier" TEXT,
    "forwarding_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "phone_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "phone_numbers_e164_key" ON "phone_numbers"("e164");

-- CreateIndex
CREATE UNIQUE INDEX "phone_numbers_twilio_sid_key" ON "phone_numbers"("twilio_sid");

-- CreateIndex
CREATE INDEX "phone_numbers_business_id_idx" ON "phone_numbers"("business_id");

-- CreateIndex
CREATE INDEX "phone_numbers_business_id_purpose_idx" ON "phone_numbers"("business_id", "purpose");

-- AddForeignKey
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

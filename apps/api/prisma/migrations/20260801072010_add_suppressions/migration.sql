-- CreateEnum
CREATE TYPE "suppression_reason" AS ENUM ('OPTED_OUT', 'NOT_TEXTABLE', 'SPAM', 'STAFF');

-- CreateTable
CREATE TABLE "suppressions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "reason" "suppression_reason" NOT NULL,
    "note" TEXT,
    "source_message_sid" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "suppressions_business_id_phone_e164_reason_idx" ON "suppressions"("business_id", "phone_e164", "reason");

-- CreateIndex
CREATE UNIQUE INDEX "suppressions_business_id_phone_e164_key" ON "suppressions"("business_id", "phone_e164");

-- AddForeignKey
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

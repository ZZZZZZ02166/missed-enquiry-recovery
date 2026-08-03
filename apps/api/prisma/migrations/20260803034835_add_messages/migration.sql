-- CreateEnum
CREATE TYPE "message_direction" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "message_status" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'UNDELIVERED', 'FAILED', 'RECEIVED');

-- CreateEnum
CREATE TYPE "message_purpose" AS ENUM ('RECOVERY', 'QUALIFICATION', 'NUDGE', 'HANDOFF', 'MANUAL', 'OWNER_NOTIFICATION');

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "call_id" TEXT,
    "direction" "message_direction" NOT NULL,
    "status" "message_status" NOT NULL,
    "purpose" "message_purpose",
    "from_e164" TEXT NOT NULL,
    "to_e164" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "provider_message_sid" TEXT,
    "segments" INTEGER NOT NULL DEFAULT 1,
    "cost_cents" INTEGER,
    "error_code" INTEGER,
    "error_message" TEXT,
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "messages_provider_message_sid_key" ON "messages"("provider_message_sid");

-- CreateIndex
CREATE INDEX "messages_business_id_customer_id_created_at_idx" ON "messages"("business_id", "customer_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_business_id_created_at_idx" ON "messages"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_business_id_status_idx" ON "messages"("business_id", "status");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

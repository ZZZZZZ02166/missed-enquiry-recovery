-- CreateEnum
CREATE TYPE "conversation_state" AS ENUM ('AWAITING_FIRST_REPLY', 'COLLECTING', 'COMPLETE', 'EXPIRED', 'OPTED_OUT');

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "call_id" TEXT,
    "state" "conversation_state" NOT NULL DEFAULT 'AWAITING_FIRST_REPLY',
    "collected" JSONB NOT NULL DEFAULT '{}',
    "awaiting_field" TEXT,
    "questions_asked" INTEGER NOT NULL DEFAULT 0,
    "needs_human" BOOLEAN NOT NULL DEFAULT false,
    "needs_human_reason" TEXT,
    "last_inbound_at" TIMESTAMP(3),
    "nudged_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversations_call_id_key" ON "conversations"("call_id");

-- CreateIndex
CREATE INDEX "conversations_state_last_inbound_at_idx" ON "conversations"("state", "last_inbound_at");

-- CreateIndex
CREATE INDEX "conversations_business_id_updated_at_idx" ON "conversations"("business_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_business_id_customer_id_state_key" ON "conversations"("business_id", "customer_id", "state");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

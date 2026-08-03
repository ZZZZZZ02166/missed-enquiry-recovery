-- CreateEnum
CREATE TYPE "message_processing_status" AS ENUM ('PENDING', 'QUEUED', 'PROCESSED', 'SKIPPED', 'FAILED');

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "processed_at" TIMESTAMP(3),
ADD COLUMN     "processing_note" TEXT,
ADD COLUMN     "processing_status" "message_processing_status";

-- CreateIndex
CREATE INDEX "messages_processing_status_created_at_idx" ON "messages"("processing_status", "created_at");

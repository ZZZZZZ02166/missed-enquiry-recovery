-- AlterEnum
ALTER TYPE "no_recovery_reason" ADD VALUE 'EXPIRED';

-- CreateIndex
CREATE INDEX "calls_recovery_sms_queued_at_idx" ON "calls"("recovery_sms_queued_at");

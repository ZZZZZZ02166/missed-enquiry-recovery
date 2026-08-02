-- AlterEnum
BEGIN;
CREATE TYPE "suppression_reason_new" AS ENUM ('NOT_TEXTABLE', 'SPAM', 'STAFF');
ALTER TABLE "suppressions" ALTER COLUMN "reason" TYPE "suppression_reason_new" USING ("reason"::text::"suppression_reason_new");
ALTER TYPE "suppression_reason" RENAME TO "suppression_reason_old";
ALTER TYPE "suppression_reason_new" RENAME TO "suppression_reason";
DROP TYPE "public"."suppression_reason_old";
COMMIT;

-- DropIndex
DROP INDEX "suppressions_business_id_phone_e164_reason_idx";

-- AlterTable
ALTER TABLE "suppressions" ADD COLUMN     "opted_out_at" TIMESTAMP(3),
ALTER COLUMN "reason" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "suppressions_business_id_reason_idx" ON "suppressions"("business_id", "reason");

-- CreateIndex
CREATE INDEX "suppressions_business_id_opted_out_at_idx" ON "suppressions"("business_id", "opted_out_at");


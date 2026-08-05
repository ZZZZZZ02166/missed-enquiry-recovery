-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "pending_choice" JSONB,
ADD COLUMN     "selected_service_id" TEXT;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_selected_service_id_fkey" FOREIGN KEY ("selected_service_id") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

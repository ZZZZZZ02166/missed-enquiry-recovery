-- AlterTable
ALTER TABLE "users" ADD COLUMN     "last_login_at" TIMESTAMP(3),
ADD COLUMN     "magic_link_expires_at" TIMESTAMP(3),
ADD COLUMN     "magic_link_sent_at" TIMESTAMP(3),
ADD COLUMN     "magic_link_token_hash" TEXT,
ADD COLUMN     "session_epoch" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "users_magic_link_token_hash_idx" ON "users"("magic_link_token_hash");

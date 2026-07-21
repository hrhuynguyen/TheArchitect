-- AlterEnum
ALTER TYPE "TransitionState" ADD VALUE 'publishing';

-- AlterTable
ALTER TABLE "TransitionJob"
  ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "leaseOwner" TEXT,
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "attemptParticipantId" TEXT,
  ADD COLUMN "attemptInputDigest" TEXT,
  ADD COLUMN "activeAiTraceId" TEXT,
  ADD COLUMN "architectureRevisionId" TEXT,
  ADD COLUMN "result" JSONB,
  ADD COLUMN "diagnostics" JSONB,
  ADD COLUMN "cleanupCompletedAt" TIMESTAMP(3),
  ADD COLUMN "phasePublishedAt" TIMESTAMP(3),
  ADD COLUMN "finishedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "TransitionJob_architectureRevisionId_key"
  ON "TransitionJob"("architectureRevisionId");

-- CreateIndex
CREATE INDEX "TransitionJob_state_leaseExpiresAt_idx"
  ON "TransitionJob"("state", "leaseExpiresAt");

-- AddForeignKey
ALTER TABLE "TransitionJob"
  ADD CONSTRAINT "TransitionJob_architectureRevisionId_fkey"
  FOREIGN KEY ("architectureRevisionId") REFERENCES "ArchitectureRevision"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

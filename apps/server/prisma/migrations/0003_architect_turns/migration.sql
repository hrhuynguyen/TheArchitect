-- AlterTable
ALTER TABLE "ArchitectProposal"
  ADD COLUMN "message" TEXT,
  ADD COLUMN "kind" TEXT,
  ADD COLUMN "actorType" TEXT,
  ADD COLUMN "actorId" TEXT,
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "sourceSnapshotVersion" INTEGER,
  ADD COLUMN "sourceProtectedDigest" TEXT,
  ADD COLUMN "sourceProtectedState" JSONB,
  ADD COLUMN "appliedRevisionId" TEXT,
  ADD COLUMN "errorCode" TEXT,
  ADD COLUMN "errorMessage" TEXT,
  ADD COLUMN "reviewIdempotencyKey" TEXT,
  ADD COLUMN "reviewedByParticipantId" TEXT,
  ADD COLUMN "reviewRationale" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "responseText" DROP NOT NULL,
  ALTER COLUMN "state" SET DEFAULT 'thinking';

-- Backfill legacy proposal rows before enforcing the durable turn invariants.
UPDATE "ArchitectProposal"
SET
  "message" = 'Legacy architect proposal was retired during migration.',
  "kind" = NULL,
  "actorType" = 'owner',
  "actorId" = 'legacy:' || "id",
  "idempotencyKey" = 'legacy:' || "id",
  "sourceSnapshotVersion" = 0,
  "sourceProtectedDigest" = repeat('0', 64),
  "sourceProtectedState" = '{}'::jsonb,
  "operations" = '[]'::jsonb,
  "responseText" = NULL,
  "state" = 'failed',
  "errorCode" = 'TURN_INTERRUPTED',
  "errorMessage" = 'The architect turn was interrupted. Submit a new request to retry.'
WHERE "message" IS NULL;

ALTER TABLE "ArchitectProposal"
  ALTER COLUMN "message" SET NOT NULL,
  ALTER COLUMN "actorType" SET NOT NULL,
  ALTER COLUMN "actorId" SET NOT NULL,
  ALTER COLUMN "idempotencyKey" SET NOT NULL,
  ALTER COLUMN "sourceSnapshotVersion" SET NOT NULL,
  ALTER COLUMN "sourceProtectedDigest" SET NOT NULL,
  ALTER COLUMN "sourceProtectedState" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ArchitectProposal_roomId_actorType_actorId_idempotencyKey_key"
  ON "ArchitectProposal"("roomId", "actorType", "actorId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ArchitectProposal_appliedRevisionId_key"
  ON "ArchitectProposal"("appliedRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "ArchitectProposal_roomId_reviewedByParticipantId_reviewIdempotencyKey_key"
  ON "ArchitectProposal"("roomId", "reviewedByParticipantId", "reviewIdempotencyKey");

-- CreateIndex
CREATE INDEX "ArchitectProposal_state_updatedAt_idx"
  ON "ArchitectProposal"("state", "updatedAt");

-- AddForeignKey
ALTER TABLE "ArchitectProposal"
  ADD CONSTRAINT "ArchitectProposal_appliedRevisionId_fkey"
  FOREIGN KEY ("appliedRevisionId") REFERENCES "ArchitectureRevision"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

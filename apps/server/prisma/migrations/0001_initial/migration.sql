-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "RoomMode" AS ENUM ('shared', 'solo');

-- CreateEnum
CREATE TYPE "RoomPhase" AS ENUM ('sketch', 'reconstructing', 'architect', 'deploy');

-- CreateEnum
CREATE TYPE "TransitionKind" AS ENUM ('ready');

-- CreateEnum
CREATE TYPE "TransitionState" AS ENUM ('claimed', 'running', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "DeployTarget" AS ENUM ('localstack', 'aws');

-- CreateEnum
CREATE TYPE "DeployState" AS ENUM ('queued', 'synthesizing', 'creating_change_set', 'awaiting_owner', 'executing', 'succeeded', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "mode" "RoomMode" NOT NULL,
    "phase" "RoomPhase" NOT NULL DEFAULT 'sketch',
    "ownerTokenHash" TEXT NOT NULL,
    "currentRevisionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Participant" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Participant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YjsSnapshot" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "payload" BYTEA NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YjsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArchitectureRevision" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "architecture" JSONB NOT NULL,
    "layout" JSONB NOT NULL,
    "requirements" JSONB NOT NULL,
    "stage" TEXT NOT NULL,
    "authorType" TEXT NOT NULL,
    "authorId" TEXT,
    "rationale" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArchitectureRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoryEvent" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "details" JSONB,
    "traceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HistoryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiRun" (
    "id" TEXT NOT NULL,
    "roomId" TEXT,
    "traceId" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "tokenMeta" JSONB,
    "errorCode" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AiRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArchitectProposal" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "baseRevisionId" TEXT NOT NULL,
    "operations" JSONB NOT NULL,
    "responseText" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'proposal_ready',
    "traceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "ArchitectProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransitionJob" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "sourceRevision" INTEGER NOT NULL,
    "kind" "TransitionKind" NOT NULL,
    "state" "TransitionState" NOT NULL DEFAULT 'claimed',
    "traceId" TEXT NOT NULL,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransitionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeployJob" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "target" "DeployTarget" NOT NULL,
    "state" "DeployState" NOT NULL DEFAULT 'queued',
    "traceId" TEXT NOT NULL,
    "region" TEXT,
    "stackName" TEXT,
    "changeSetName" TEXT,
    "approvalFacts" JSONB NOT NULL,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "DeployJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeployLog" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "stage" TEXT NOT NULL,
    "line" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeployLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Participant_roomId_idx" ON "Participant"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "YjsSnapshot_roomId_version_key" ON "YjsSnapshot"("roomId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ArchitectureRevision_roomId_version_key" ON "ArchitectureRevision"("roomId", "version");

-- CreateIndex
CREATE INDEX "HistoryEvent_roomId_createdAt_idx" ON "HistoryEvent"("roomId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiRun_traceId_key" ON "AiRun"("traceId");

-- CreateIndex
CREATE UNIQUE INDEX "ArchitectProposal_traceId_key" ON "ArchitectProposal"("traceId");

-- CreateIndex
CREATE INDEX "ArchitectProposal_roomId_createdAt_idx" ON "ArchitectProposal"("roomId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TransitionJob_traceId_key" ON "TransitionJob"("traceId");

-- CreateIndex
CREATE UNIQUE INDEX "TransitionJob_roomId_sourceRevision_kind_key" ON "TransitionJob"("roomId", "sourceRevision", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "DeployJob_traceId_key" ON "DeployJob"("traceId");

-- CreateIndex
CREATE INDEX "DeployJob_roomId_createdAt_idx" ON "DeployJob"("roomId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeployLog_jobId_sequence_key" ON "DeployLog"("jobId", "sequence");

-- AddForeignKey
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YjsSnapshot" ADD CONSTRAINT "YjsSnapshot_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArchitectureRevision" ADD CONSTRAINT "ArchitectureRevision_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoryEvent" ADD CONSTRAINT "HistoryEvent_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArchitectProposal" ADD CONSTRAINT "ArchitectProposal_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransitionJob" ADD CONSTRAINT "TransitionJob_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeployJob" ADD CONSTRAINT "DeployJob_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeployJob" ADD CONSTRAINT "DeployJob_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "ArchitectureRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeployLog" ADD CONSTRAINT "DeployLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "DeployJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

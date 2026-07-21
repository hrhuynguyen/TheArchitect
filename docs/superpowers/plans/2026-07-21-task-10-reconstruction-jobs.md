# Task 10 Reconstruction Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert a server-claimed readiness snapshot into exactly one durable typed architecture revision through a restart-safe AI job, and expose the same safe analysis pipeline in an authenticated diagnostic bench.

**Architecture:** A Prisma-backed state machine owns short leased and token-fenced transactions, while provider calls and Yjs publication run outside transactions. A shared PNG/provider/compiler analysis boundary serves room jobs and zero-mutation debug parsing; browser orchestration is keyed by the authoritative transition claim and polls strict public job envelopes.

**Tech Stack:** TypeScript, Zod, Prisma/PostgreSQL, Fastify 5, Yjs/Hocuspocus, React 19, Next.js 16 App Router, Vitest, Testing Library, Task 8 compiler, and Task 9 AI providers.

## Global Constraints

- Work only in `/Users/henrynguyen/Documents/TheArchitect/.worktrees/architect-build` on `feature/architect-build`.
- Use Node.js 22.12 or newer and the existing npm workspace dependency graph.
- Do not add Gemini dependencies, keys, environment variables, provider paths, or copy.
- Never persist or log prompts, PNG bytes, base64/data URLs, cookies, API keys, safety identifiers, SDK responses, raw SDK errors, or provider secrets.
- Keep decoded PNG input at or below 5 MiB, dimensions at or below 4096×4096, and total pixels at or below 16,777,216; precheck encoded length before decoding.
- Keep provider calls and Yjs work outside database transactions.
- Use 30-second leases, 10-second heartbeat renewal, attempt-scoped participant/digest/AI trace facts, and lease-token fencing on every state-changing write.
- A fresh running lease returns HTTP 202 without replacing input; an expired lease may be reclaimed by any authorized voter in the exact source snapshot.
- Provider execution is at-least-once after crash; exactly one revision and one deterministic reconstruction history event may commit for a transition job.
- Do not reopen Room `sketch` after terminal failure until old readiness deletion and the sketch mirror are persisted and published.
- Startup recovery may finish only publishing, failed-cleanup, and successful phase-mirror work; it never invokes AI without client-provided bytes.
- Every recovery publisher, cleanup, or phase-mirror mutation conditionally claims and renews a state-specific lease/token first, uses that token as its write fence, and never steals a fresh lease.
- Debug API and page require `ENABLE_DEBUG_ROUTES=true`, non-production, and room member/owner authorization; debug creates no durable or Yjs state.
- Use only the existing cookie-signing secret with a domain-separated HMAC for provider safety identity.
- Keep semantic architecture and layout separate in revisions and Yjs.
- Follow strict TDD: observe each focused RED for the missing behavior before production implementation, then observe GREEN.
- Use `apply_patch` for source/document edits. Do not push.

---

### Task 1: Add strict reconstruction contracts and authoritative claim versions

**Files:**
- Create: `packages/contracts/src/reconstruction.ts`
- Create: `packages/contracts/src/reconstruction.test.ts`
- Modify: `packages/contracts/src/voting.ts`
- Modify: `packages/contracts/src/voting.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/package.json`
- Modify: `apps/server/src/rooms/vote.service.ts`
- Modify: `apps/server/src/rooms/vote.service.test.ts`
- Modify: `apps/server/src/rooms/vote.persistence.integration.test.ts`
- Modify: `apps/web/src/features/sketch/ReadinessVote.test.tsx`

**Interfaces:**
- Consumes: Task 8 infrastructure schemas, `RequirementsProfileSchema`, and Task 7 `TransitionClaimSchema`.
- Produces: `ReconstructionRequestSchema`, `ReconstructionAnalysisSchema`, `ReconstructionResultSchema`, `ReconstructionJobEnvelopeSchema`, `DebugReconstructionRequestSchema`, `DebugReconstructionResponseSchema`, working architecture/layout schemas, `ARCHITECTURE_MAP_KEY`, and `ARCHITECTURE_LAYOUT_MAP_KEY`.
- Produces: `TransitionClaim { claimed, jobId, sourceSnapshotVersion }` whose version equals the durable job source revision.

- [ ] **Step 1: Write failing reconstruction contract tests**

Add tests that parse a complete success and reject extra fields, negative source versions, unsupported MIME, missing provider model, inconsistent job state/result combinations, and architecture/layout values with mismatched revision IDs:

```ts
it("accepts one strict succeeded job envelope", () => {
  expect(ReconstructionJobEnvelopeSchema.parse({
    jobId: "job-a",
    sourceSnapshotVersion: 7,
    state: "succeeded",
    result: {
      traceId: "trace-a",
      provider: { provider: "openai", model: "gpt-5.6" },
      intent: validIntent,
      diagnostics: [],
      stageDecision: compiled.stageDecision,
      deploymentPlan: compiled.deploymentPlan,
      architectureRevisionId: "revision-a",
    },
    error: null,
  }).result?.architectureRevisionId).toBe("revision-a");
});

it("rejects a result on a running job", () => {
  expect(ReconstructionJobEnvelopeSchema.safeParse({
    jobId: "job-a",
    sourceSnapshotVersion: 7,
    state: "running",
    result: validResult,
    error: null,
  }).success).toBe(false);
});
```

- [ ] **Step 2: Run the contract RED**

Run: `npm test --workspace @architect/contracts -- reconstruction.test.ts`

Expected: FAIL because `reconstruction.ts` and its exports do not exist.

- [ ] **Step 3: Implement strict reconstruction schemas and exports**

Define strict schemas by composing the existing source schemas, including a discriminated job union:

```ts
export const reconstructionProviderSchema = z.strictObject({
  provider: z.enum(["openai", "anthropic"]),
  model: z.string().trim().min(1).max(200),
});

export const reconstructionRequestSchema = z.strictObject({
  imageDataUrl: z.string().min(PNG_DATA_URL_PREFIX.length + 1).max(6_990_530),
  mimeType: z.literal("image/png"),
  requirements: RequirementsProfileSchema,
  sourceSnapshotVersion: z.number().int().nonnegative(),
});

export const reconstructionJobEnvelopeSchema = z.discriminatedUnion("state", [
  inFlightJobSchema.extend({ state: z.enum(["claimed", "running", "publishing"]) }).strict(),
  terminalJobSchema.extend({ state: z.literal("succeeded"), result: ReconstructionResultSchema, error: z.null() }).strict(),
  terminalJobSchema.extend({ state: z.literal("failed"), result: z.null(), error: ReconstructionPublicErrorSchema }).strict(),
]);
```

Export both lower-camel and existing project-style Pascal aliases and add the `./reconstruction` package export.
Define `MAX_PNG_BASE64_CHARS = 6_990_508` and
`MAX_RECONSTRUCTION_DATA_URL_CHARS = PNG_DATA_URL_PREFIX.length +
MAX_PNG_BASE64_CHARS` (6,990,530). The contract limit includes the exact
`data:image/png;base64,` prefix; the lower base64 ceiling does not.

- [ ] **Step 4: Write failing Task 7 claim-version regressions**

Update voting schemas/tests and vote service tests so winner and duplicate require the durable source revision:

```ts
expect(first.transition).toEqual({
  claimed: true,
  jobId: "job-1",
  sourceSnapshotVersion: 7,
});
expect(replay.transition).toEqual({
  claimed: false,
  jobId: "job-1",
  sourceSnapshotVersion: 7,
});
```

In the PostgreSQL concurrency test, compare both returned versions to the created row's `sourceRevision`.

- [ ] **Step 5: Run the Task 7 RED**

Run: `npm test --workspace @architect/contracts -- voting.test.ts && npm test --workspace @architect/server -- vote.service.test.ts`

Expected: FAIL because current claims contain only `claimed` and `jobId`.

- [ ] **Step 6: Return the server-owned source version**

Change the internal claim result and every duplicate path to use the selected durable record:

```ts
type TransitionClaimResult = {
  claimed: boolean;
  jobId: string;
  sourceSnapshotVersion: number;
};

return {
  claimed: true,
  jobId: job.id,
  sourceSnapshotVersion: job.sourceRevision,
};
```

Update strict web fixtures to include the new required field; do not make it optional.

- [ ] **Step 7: Run Task 1 GREEN and commit**

Run: `npm test --workspace @architect/contracts -- reconstruction.test.ts voting.test.ts && npm test --workspace @architect/server -- vote.service.test.ts && npm test --workspace @architect/web -- ReadinessVote.test.tsx`

Expected: all selected tests pass.

Commit: `git commit -m "feat: define reconstruction job contracts"`

---

### Task 2: Add the forward migration and Prisma reconstruction repository

**Files:**
- Modify: `apps/server/prisma/schema.prisma`
- Create: `apps/server/prisma/migrations/0002_reconstruction_jobs/migration.sql`
- Create: `apps/server/src/reconstruction/reconstruction.repository.ts`
- Create: `apps/server/src/reconstruction/reconstruction.repository.test.ts`
- Create: `apps/server/src/reconstruction/reconstruction.persistence.integration.test.ts`

**Interfaces:**
- Consumes: existing `TransitionJob`, `ArchitectureRevision`, `HistoryEvent`, `AiRun`, and Room models.
- Produces: `ReconstructionRepository` operations `readCurrent`, `readById`, `claimAttempt`, `claimRecovery`, `renewLease`, `recordAiTerminal`, `commitAnalysis`, `recordFailure`, `completeSuccess`, `completeFailureCleanup`, `completePhaseMirror`, and `listRecoverable`.
- Produces: lease value `{ jobId, token, attempt, aiTraceId, expiresAt }` and explicit outcomes `claimed | in_flight | terminal | lost`.

- [ ] **Step 1: Write repository REDs for claim, reclaim, and fencing**

Use an in-memory transactional database boundary for fast tests and an opt-in Prisma integration block for PostgreSQL. Cover:

```ts
it("does not replace a fresh running attempt", async () => {
  const first = await repository.claimAttempt(validClaim("participant-a", "digest-a"));
  const duplicate = await repository.claimAttempt(validClaim("participant-b", "digest-b"));
  expect(first.kind).toBe("claimed");
  expect(duplicate).toEqual(expect.objectContaining({ kind: "in_flight" }));
  expect(await currentAttempt()).toMatchObject({
    attemptParticipantId: "participant-a",
    attemptInputDigest: "digest-a",
  });
});

it("fences an expired attempt after another voter reclaims it", async () => {
  const oldLease = await claimAt(now, "participant-a", "digest-a");
  const newLease = await claimAt(afterLeaseExpiry, "participant-b", "digest-b");
  await expect(repository.commitAnalysis(oldLease.lease, analysis)).resolves.toEqual({ kind: "lost" });
  await expect(repository.commitAnalysis(newLease.lease, analysis)).resolves.toMatchObject({ kind: "publishing" });
});
```

Also assert one revision/history across concurrent commits, completed AiRun without commit causing a new attempt, safe abandoned AiRun closure, heartbeat renewal, terminal replay, recoverable-state filtering, and exactly one recovery lease winner without stealing a fresh recovery owner. Assert a newly claimed running AiRun is seeded with the configured primary provider/model identity; terminal recording may replace those fields with the selected fallback identity, and no `pending`, empty, or invented identity is persisted.

- [ ] **Step 2: Run the repository RED**

Run: `npm test --workspace @architect/server -- reconstruction.repository.test.ts reconstruction.persistence.integration.test.ts`

Expected: FAIL because the repository and migration-backed fields do not exist.

- [ ] **Step 3: Add the migration and schema fields**

Use a forward enum/table alteration and preserve `0001_initial`:

```sql
ALTER TYPE "TransitionState" ADD VALUE 'publishing';
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
CREATE UNIQUE INDEX "TransitionJob_architectureRevisionId_key" ON "TransitionJob"("architectureRevisionId");
CREATE INDEX "TransitionJob_state_leaseExpiresAt_idx" ON "TransitionJob"("state", "leaseExpiresAt");
ALTER TABLE "TransitionJob" ADD CONSTRAINT "TransitionJob_architectureRevisionId_fkey"
  FOREIGN KEY ("architectureRevisionId") REFERENCES "ArchitectureRevision"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
```

Model the named one-to-one Prisma relation and run client generation before repository typechecking.

- [ ] **Step 4: Implement token-fenced short transactions**

Use conditional `updateMany` as the fence and serializable retry for version races. The commit transaction must follow this order:

```ts
const fenced = await transaction.transitionJob.updateMany({
  where: { id: lease.jobId, state: "running", leaseToken: lease.token },
  data: { state: "publishing" },
});
if (fenced.count !== 1) return { kind: "lost" } as const;
const latest = await transaction.architectureRevision.aggregate({
  where: { roomId: job.roomId },
  _max: { version: true },
});
const revision = await transaction.architectureRevision.create({
  data: revisionData(job, analysis, (latest._max.version ?? 0) + 1),
});
await transaction.historyEvent.create({
  data: historyData(`reconstruction:${job.id}`, job, analysis),
});
await transaction.transitionJob.update({
  where: { id: job.id },
  data: { architectureRevisionId: revision.id, result: boundedResult(revision.id, analysis) },
});
return { kind: "publishing", revision } as const;
```

The actual implementation performs all writes in the same transaction and retries only `P2002`/`P2034` version races.

- [ ] **Step 5: Validate Prisma and run Task 2 GREEN**

Run: `npm run db:generate && npx prisma validate --schema apps/server/prisma/schema.prisma && npm test --workspace @architect/server -- reconstruction.repository.test.ts reconstruction.persistence.integration.test.ts`

Expected: schema valid; fast repository tests pass; PostgreSQL tests pass when the existing opt-in database environment is available and otherwise skip with the established test convention.

Commit: `git commit -m "feat: persist leased reconstruction jobs"`

---

### Task 3: Build bounded PNG validation and the shared analysis pipeline

**Files:**
- Create: `apps/server/src/reconstruction/png.ts`
- Create: `apps/server/src/reconstruction/png.test.ts`
- Create: `apps/server/src/reconstruction/reconstruction.pipeline.ts`
- Create: `apps/server/src/reconstruction/reconstruction.pipeline.test.ts`

**Interfaces:**
- Consumes: Task 9 `AiProvider`, `AiRunRecorder`, and Task 8 `compileIntent`.
- Produces: `validateReconstructionPng(input): { imageDataUrl, digest, width, height }` and `analyzeReconstruction(input, recordedProvider): ReconstructionAnalysis`, where `recordedProvider` contains an `AiProvider` already bound to exactly one supplied recorder plus a read-only terminal-metadata accessor.
- Produces: `RecordedReconstructionProvider = { provider: AiProvider; terminal(): AiRunTerminalMetadata | null }`; no recorder argument exists on `analyzeReconstruction`.
- Guarantees: encoded-length precheck occurs before `Buffer.from`; returned digest is hex SHA-256; no raw input exists in terminal metadata/errors.

- [ ] **Step 1: Write exact PNG boundary REDs**

Construct PNG chunks in test code and assert canonical data, 5 MiB, 4096 dimensions, and pixel boundaries. Reject malformed base64, noncanonical padding, wrong signature, non-IHDR first, duplicate IHDR, missing/nonterminal IEND, out-of-bounds chunks, excessive chunks, zero/4097 dimensions, pixel overflow, and encoded payload above 6,990,508 before decode.

```ts
it("rejects encoded input above the ceiling without decoding", () => {
  const decode = vi.fn();
  expect(() => validateReconstructionPng({
    imageDataUrl: `data:image/png;base64,${"A".repeat(MAX_PNG_BASE64_CHARS + 1)}`,
    mimeType: "image/png",
  }, { decode })).toThrowError(expect.objectContaining({ code: "INVALID_PNG" }));
  expect(decode).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run PNG RED**

Run: `npm test --workspace @architect/server -- png.test.ts`

Expected: FAIL because `png.ts` does not exist.

- [ ] **Step 3: Implement bounded structural validation**

Parse unsigned 32-bit chunk lengths with overflow-safe bounds and return only safe facts:

```ts
if (encoded.length > MAX_PNG_BASE64_CHARS || !CANONICAL_BASE64.test(encoded)) {
  throw invalidPng();
}
const bytes = decode(encoded);
if (bytes.byteLength > MAX_PNG_BYTES) throw invalidPng();
const dimensions = validateChunks(bytes);
return Object.freeze({
  imageDataUrl: input.imageDataUrl,
  digest: createHash("sha256").update(bytes).digest("hex"),
  ...dimensions,
});
```

- [ ] **Step 4: Write pipeline REDs**

Cover provider success, selected fallback metadata, blocking compiler output returned to debug, stable AI errors, missing terminal callback, and sentinel scans proving neither result nor captured logs/metadata contain the input data URL, fixed prompts, fake keys, safety identifier, or raw provider message. Assert the pipeline never accepts a second recorder argument and rejects provider success when its single bound recorder produced no terminal metadata.

- [ ] **Step 5: Run pipeline RED**

Run: `npm test --workspace @architect/server -- reconstruction.pipeline.test.ts`

Expected: FAIL because the shared analysis function does not exist.

- [ ] **Step 6: Implement one provider/compiler pipeline**

Read the sanitized terminal record captured by the provider's one already-bound
recorder and compile validated intent. The analysis API has no recorder
parameter:

```ts
const intent = await recordedProvider.provider.reconstruct({
  traceId: input.aiTraceId,
  safetyIdentifier: input.safetyIdentifier,
  imageDataUrl: input.imageDataUrl,
});
const compiled = compileIntent(intent, input.requirements);
const terminal = recordedProvider.terminal();
if (!terminal) throw new AiRecorderError(input.aiTraceId);
return ReconstructionAnalysisSchema.parse({
  provider: { provider: terminal.provider, model: terminal.model },
  intent,
  ...compiled,
});
```

`recordedProvider.provider` is the Task 9 failover provider already bound to the
single supplied recorder. Room and debug callers construct that boundary once;
the pipeline cannot double-record.

- [ ] **Step 7: Run Task 3 GREEN and commit**

Run: `npm test --workspace @architect/server -- png.test.ts reconstruction.pipeline.test.ts && npm test --workspace @architect/server -- provider.test.ts openai.provider.test.ts anthropic.provider.test.ts failover.test.ts`

Expected: all selected tests pass.

Commit: `git commit -m "feat: validate reconstruction analysis input"`

---

### Task 4: Orchestrate room jobs, failure cleanup, Yjs publication, and recovery

**Files:**
- Create: `apps/server/src/reconstruction/reconstruction.publisher.ts`
- Create: `apps/server/src/reconstruction/reconstruction.publisher.test.ts`
- Create: `apps/server/src/reconstruction/reconstruction.service.ts`
- Create: `apps/server/src/reconstruction/reconstruction.service.test.ts`
- Modify: `apps/server/src/rooms/vote.service.test.ts`

**Interfaces:**
- Consumes: `ReconstructionRepository`, shared analysis pipeline, active document registry, Yjs snapshot persistence, and Task 7 server vote map.
- Produces: `reconstruct`, `currentJob`, `jobById`, `debugAnalyze`, `recover`, `settle`, and `destroy`.
- Produces: publisher operations `publishArchitecture`, `publishFailureCleanup`, and `publishArchitectPhase` that clone before mutation and preserve sketch/requirements maps.

- [ ] **Step 1: Write publisher ordering REDs**

Assert candidate snapshot persistence precedes live publication, architecture and layout revision IDs match, unrelated maps remain byte-equivalent, and injected persistence/publication failures leave the live document unchanged:

```ts
it("persists a cloned architecture before publishing its delta", async () => {
  await publisher.publishArchitecture(job);
  expect(events).toEqual(["persist:reconstruction_architecture", "publish"]);
  expect(readSketch(live)).toEqual(originalSketch);
  expect(readRequirements(live)).toEqual(originalRequirements);
  expect(readWorkingArchitecture(live).revisionId).toBe(job.revisionId);
});
```

- [ ] **Step 2: Run publisher RED**

Run: `npm test --workspace @architect/server -- reconstruction.publisher.test.ts`

Expected: FAIL because the publisher does not exist.

- [ ] **Step 3: Implement clone-persist-publish operations**

Use state-vector deltas and explicit Yjs origins:

```ts
const candidate = cloneDocument(live);
candidate.getMap(ARCHITECTURE_MAP_KEY).set("current", workingArchitecture);
candidate.getMap(ARCHITECTURE_LAYOUT_MAP_KEY).set("current", layout);
await persistRoomSnapshot(roomId, candidate, "reconstruction_architecture");
const delta = Y.encodeStateAsUpdate(candidate, Y.encodeStateVector(live));
Y.applyUpdate(live, delta, "architect/server-reconstruction");
```

Failure cleanup deletes only `SERVER_VOTES_MAP_KEY`'s `ready` value and writes `meta.phase = sketch`.

- [ ] **Step 4: Write service REDs for success and failure**

Cover exact snapshot requirements/voter validation, fresh 202, expired reclaim by a different voter/digest, heartbeat, stale token, success, compiler failure, provider outage, terminal replay, and HMAC safety ID. Assert no transaction spans the deferred provider promise.

```ts
it("creates one revision and advances only after architecture publication", async () => {
  const result = await service.reconstruct(validInput);
  expect(result.state).toBe("succeeded");
  expect(store.revisionCount(roomId)).toBe(1);
  expect(store.historyCountFor(jobId)).toBe(1);
  expect(events).toEqual([
    "claim-commit", "provider-start", "provider-finish", "revision-commit",
    "architecture-persist", "architecture-publish", "success-commit", "phase-mirror",
  ]);
});
```

- [ ] **Step 5: Run service RED**

Run: `npm test --workspace @architect/server -- reconstruction.service.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 6: Implement service orchestration and heartbeat**

Use a cancellable interval only around running provider/compiler work, and always fence completion. Seed the running AiRun from `provider.identity("reconstruct")` before the external call; Task 9 terminal recording replaces it only with the actual selected fallback identity. Keep pre-commit analysis failure, post-commit publication failure, and lost-fence outcomes separate:

```ts
const heartbeat = startLeaseHeartbeat({
  everyMs: 10_000,
  renew: () => repository.renewLease(lease, clock.now()),
});
let committed;
try {
  const analysis = await analyzeReconstruction(pipelineInput, provider);
  committed = await repository.commitAnalysis(lease, analysis);
  if (committed.kind === "lost") return repository.readById(input.roomId, lease.jobId);
} catch (error) {
  return failAndCleanUp(lease, publicReconstructionFailure(error));
} finally {
  heartbeat.stop();
}
try {
  await publisher.publishArchitecture(committed.job);
} catch {
  return repository.readById(input.roomId, lease.jobId);
}
await repository.completeSuccess(lease);
await publishPhaseWithRetry(committed.job);
return repository.readById(input.roomId, lease.jobId);
```

`failAndCleanUp` records the stable failed result while Room remains
reconstructing, persists/publishes old-readiness deletion plus the sketch
mirror, and only then conditionally completes cleanup and reopens Room sketch.
The real implementation never treats a post-commit publication failure as a
terminal reconstruction failure and never lets a stale worker record job
failure.

- [ ] **Step 7: Add the failure crash/race RED**

Pause after durable failure recording, assert Room remains reconstructing and Task 7 returns `VoteClosedError`, attempt a new vote, restart the service, finish old cleanup, then assert Room is sketch, old ready value is absent, and a later new vote is preserved.

- [ ] **Step 8: Add publication/restart recovery REDs**

Inject failure after revision commit but before Yjs persist, after persist but before live publish, and after success before phase mirror. Recreate service with the same store and assert `recover()` finishes only publishing/cleanup/mirror jobs, calls no provider, and creates no duplicate revision/history.

- [ ] **Step 9: Implement bounded startup/replay recovery**

Dispatch recovery by durable facts only:

```ts
for (const candidate of await repository.listRecoverable(clock.now())) {
  const claimed = await repository.claimRecovery(candidate.id, candidate.state, clock.now());
  if (claimed.kind !== "claimed") continue;
  const job = claimed.job;
  if (job.state === "publishing") await resumePublication(job, claimed.lease);
  else if (job.state === "failed" && !job.cleanupCompletedAt) await resumeFailureCleanup(job, claimed.lease);
  else if (job.state === "succeeded" && !job.phasePublishedAt) await resumePhaseMirror(job, claimed.lease);
}
```

`listRecoverable(now)` returns only publication/cleanup/mirror candidates whose
lease is absent or expired. Before each publisher, cleanup, or mirror mutation,
`claimRecovery` conditionally takes the matching state-specific lease/token and
starts the same 10-second renewal discipline; every repository completion uses
that token as a fence. Concurrent processes have one winner and cannot steal a
fresh owner. Never include claimed or running jobs in this list.

- [ ] **Step 10: Run Task 4 GREEN and commit**

Run: `npm test --workspace @architect/server -- reconstruction.publisher.test.ts reconstruction.service.test.ts vote.service.test.ts`

Expected: all selected tests pass, including exact crash/race and all Yjs failure windows.

Commit: `git commit -m "feat: run recoverable reconstruction jobs"`

---

### Task 5: Add authenticated room/debug routes and runtime provider wiring

**Files:**
- Create: `apps/server/src/reconstruction/reconstruction.routes.ts`
- Create: `apps/server/src/reconstruction/reconstruction.routes.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/config/env.test.ts`

**Interfaces:**
- Consumes: participant signature verification, owner-token verification through Room service/config, reconstruction service, Task 9 provider constructors/failover, and Prisma.
- Produces: room POST, current-claim GET, job polling GET, and gated room-authenticated debug POST.
- Guarantees: reconstruction POST route `bodyLimit` is 7,100,000; current/job GET returns no internal attempt/lease fields.

- [ ] **Step 1: Write route authorization and payload REDs**

Test signed member success for both GET and debug, verified owner success for
both GET and debug, source-voter member POST success, owner-only POST denial,
missing/tampered/cross-room participant denial, cross-room job 404,
malformed/oversized body, fresh 202, terminal 200, stable error mapping, and
response sentinel redaction.

```ts
it("does not reveal a job through a different room", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/rooms/room-b/reconstruction/job-a",
    headers: { cookie: memberCookie("room-b", "participant-b") },
  });
  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({ code: "reconstruction_not_found", message: "Reconstruction not found" });
});
```

- [ ] **Step 2: Run route RED**

Run: `npm test --workspace @architect/server -- reconstruction.routes.test.ts app.test.ts`

Expected: FAIL because routes are not registered.

- [ ] **Step 3: Implement one room-bound authorization helper and routes**

Authenticate membership first, then owner without trusting raw cookie names from the request:

```ts
const access = await authorizeRoomRequest(request, roomId, options);
if (!access) return unauthorizedOrNotFound(reply);

app.post("/api/rooms/:roomId/reconstruction", { bodyLimit: RECONSTRUCTION_BODY_LIMIT }, async (request, reply) => {
  const participant = await requireParticipant(request, reply, options);
  if (!participant) return reply;
  const envelope = await options.service.reconstruct({ roomId, participantId: participant.id, request: request.body });
  return reply.code(isInFlight(envelope) ? 202 : 200).send(envelope);
});
```

Public error mapping uses only fixed code/message/status tuples.

- [ ] **Step 4: Write debug gate/non-mutation REDs**

Build apps under disabled, production-enabled, and development-enabled configs. Assert 404 unless both gates pass; under the enabled gate assert member/owner authorization and snapshot all repository/Yjs counts/bytes before and after debug success and compiler-error responses.

- [ ] **Step 5: Implement gated debug registration**

Register the debug POST only when:

```ts
const debugEnabled = config.enableDebugRoutes && config.nodeEnv !== "production";
if (debugEnabled) registerDebugReconstructionRoute(app, options);
```

The debug service supplies an in-memory awaited Task 9 recorder and never uses the reconstruction repository/publisher.

- [ ] **Step 6: Wire real runtime providers and startup recovery**

Build OpenAI primary, optional configured Anthropic fallback, and Task 9 failover inside an injected provider factory. Call `await reconstructionService.recover()` before listening. Do not inspect or print key values. The factory passes the provided awaited recorder directly to `createFailoverProvider`.

- [ ] **Step 7: Run Task 5 GREEN and commit**

Run: `npm test --workspace @architect/server -- reconstruction.routes.test.ts app.test.ts config/env.test.ts && npm run typecheck --workspace @architect/server`

Expected: route/gate tests and server typecheck pass.

Commit: `git commit -m "feat: expose authenticated reconstruction APIs"`

---

### Task 6: Add idempotent web reconstruction orchestration

**Files:**
- Create: `apps/web/src/features/sketch/useReconstruction.ts`
- Create: `apps/web/src/features/sketch/useReconstruction.test.tsx`
- Modify: `apps/web/src/features/sketch/ReadinessVote.tsx`
- Modify: `apps/web/src/features/sketch/ReadinessVote.test.tsx`
- Modify: `apps/web/src/features/sketch/Whiteboard.tsx`
- Modify: `apps/web/src/features/sketch/Whiteboard.test.tsx`

**Interfaces:**
- Consumes: `captureWhiteboard`, `readRequirements`, strict reconstruction/claim schemas, editor getter, and durable phase callback.
- Produces: `{ begin(claim), discover(), retry(), state }` keyed by job ID.
- Guarantees: one capture per active attempt, bounded polling, response claim match, abort/unmount cleanup, and no authority from local/Yjs values.

- [ ] **Step 1: Write hook REDs**

Use a real Y.Doc and injected capture/fetch/clock boundaries. Cover double `begin`, exact claim version, one capture, 202 polling, terminal success, terminal failure, current-claim discovery, mismatched response job rejection, bounded network retry, unmount abort, and release of the data URL reference.

```tsx
await act(async () => {
  result.current.begin({ claimed: true, jobId: "job-a", sourceSnapshotVersion: 7 });
  result.current.begin({ claimed: false, jobId: "job-a", sourceSnapshotVersion: 7 });
});
expect(capture).toHaveBeenCalledOnce();
expect(fetcher).toHaveBeenNthCalledWith(1, "/api/rooms/room-a/reconstruction", expect.objectContaining({
  method: "POST",
  body: expect.stringContaining('"sourceSnapshotVersion":7'),
}));
```

- [ ] **Step 2: Run hook RED**

Run: `npm test --workspace @architect/web -- useReconstruction.test.tsx`

Expected: FAIL because the hook does not exist.

- [ ] **Step 3: Implement a reducer-driven idempotent hook**

Store job control facts in refs and expose only safe UI state:

```ts
if (activeJobRef.current === claim.jobId) return;
activeJobRef.current = claim.jobId;
const capture = await captureCurrentWhiteboard();
try {
  await submitAndPoll(claim, capture, RequirementsProfileSchema.parse(readRequirements(doc)));
} finally {
  capture.imageDataUrl = "";
}
```

Use `AbortController`, bounded delay constants, strict response schemas, and `credentials: "same-origin"`.

- [ ] **Step 4: Write ReadinessVote/Whiteboard integration REDs**

Assert the validated mutation claim reaches the hook once, remote reconstructing state discovers the current job, reconstruction failure shows retry-safe status and returns to voting only after durable sketch confirmation, and editor/requirements boundaries are connected without placing image data in component state or markup.

- [ ] **Step 5: Integrate the hook**

Add `onTransitionClaim` to `ReadinessVote`, instantiate the hook in connected Whiteboard with `() => editorRef.current`, and render text-only reconstruction status/retry controls. Preserve all current Task 7 phase-authority tests.

- [ ] **Step 6: Run Task 6 GREEN and commit**

Run: `npm test --workspace @architect/web -- useReconstruction.test.tsx ReadinessVote.test.tsx Whiteboard.test.tsx captureWhiteboard.test.ts`

Expected: all selected tests pass.

Commit: `git commit -m "feat: reconstruct from readiness claims"`

---

### Task 7: Build the authenticated non-production diagnostic bench

**Files:**
- Create: `apps/web/src/features/debug/DebugBench.tsx`
- Create: `apps/web/src/features/debug/DebugBench.test.tsx`
- Create: `apps/web/src/app/debug/page.tsx`
- Create: `apps/web/src/app/debug/page.test.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: debug request/response schemas and default requirements.
- Produces: a room-ID plus PNG/workload diagnostic form and accessible JSON result panels.
- Guarantees: no key/token/provider/model/prompt/data-URL field or image preview; page calls `notFound()` unless explicitly enabled and non-production.

- [ ] **Step 1: Write DebugBench REDs**

Test accessible room ID/file/workload inputs, PNG-only rejection, pending/error/success states, all required output headings, strict response validation, and absence of sensitive controls/content:

```tsx
expect(screen.queryByLabelText(/api key|token|provider|model|prompt|data url/i)).not.toBeInTheDocument();
expect(container.querySelector("img")).toBeNull();
expect(screen.getByRole("heading", { name: "Semantic graph" })).toBeVisible();
expect(screen.getByRole("heading", { name: "Deployment plan" })).toBeVisible();
```

- [ ] **Step 2: Run bench RED**

Run: `npm test --workspace @architect/web -- DebugBench.test.tsx page.test.tsx`

Expected: FAIL because the page and component do not exist.

- [ ] **Step 3: Implement safe file submission and result panels**

Read the selected PNG into a local request value, submit to the room-scoped debug route, clear the local data URL in `finally`, and render JSON with `JSON.stringify(validatedValue, null, 2)` only for validated safe response fields. Reuse workload select semantics from `RequirementsPanel` without adding shared mutable Yjs state.

- [ ] **Step 4: Implement server-side Next page gate**

```tsx
export default function DebugPage() {
  if (process.env.ENABLE_DEBUG_ROUTES !== "true" || process.env.NODE_ENV === "production") {
    notFound();
  }
  return <DebugBench />;
}
```

Add focused warm-white/graphite responsive styles using existing tokens and visible keyboard focus.

- [ ] **Step 5: Run Task 7 GREEN and commit**

Run: `npm test --workspace @architect/web -- DebugBench.test.tsx page.test.tsx && npm run typecheck --workspace @architect/web`

Expected: tests and web typecheck pass.

Commit: `git commit -m "feat: add reconstruction diagnostic bench"`

---

### Task 8: Demonstrate Milestone 3, review, verify, report, and commit fixes

**Files:**
- Create: `.superpowers/sdd/task-10-report.md` (ignored evidence report)
- Modify only files required by verified review findings.

**Interfaces:**
- Consumes: completed Tasks 1–7 and the approved Task 10 specification.
- Produces: browser/API/restart/outage evidence, final scans, fresh review, focused fix commit if needed, and a clean local branch.

- [ ] **Step 1: Run focused reconstruction gates**

Run:

```bash
npm test --workspace @architect/contracts -- reconstruction.test.ts voting.test.ts
npm test --workspace @architect/server -- reconstruction.repository.test.ts reconstruction.persistence.integration.test.ts png.test.ts reconstruction.pipeline.test.ts reconstruction.publisher.test.ts reconstruction.service.test.ts reconstruction.routes.test.ts
npm test --workspace @architect/web -- useReconstruction.test.tsx ReadinessVote.test.tsx Whiteboard.test.tsx DebugBench.test.tsx page.test.tsx
```

Expected: all focused tests pass; opt-in database tests either pass against the configured PostgreSQL service or use the repository's established intentional skip.

- [ ] **Step 2: Run Prisma and complete repository gates**

Run:

```bash
npm run db:generate
npx prisma validate --schema apps/server/prisma/schema.prisma
npm test
npm run lint
npm run typecheck
npm run build
npm run typecheck
git diff --check
```

Run the full suite outside the sandbox when local WebSocket port binding requires it. Expected: zero failures, lint/typecheck/build success, fresh post-build typecheck success, and clean diff whitespace.

- [ ] **Step 3: Gather deterministic Milestone 3 evidence**

Use an injected deterministic provider and real Fastify/Yjs/Prisma boundaries to demonstrate:

1. a known supplier-portal PNG/request reaches one typed revision with provenance;
2. duplicate/concurrent/restart requests return the same revision;
3. a provider outage leaves the sketch/requirements byte-equivalent, clears old readiness, and reopens sketch only after cleanup;
4. restart recovery finishes publishing and phase mirror without provider calls; and
5. debug analysis returns the same intent/compiler result while all room/job/revision/history/AiRun/Yjs counts and bytes remain unchanged.

Record commands, counts, IDs/hashes, and redacted output summaries in `.superpowers/sdd/task-10-report.md`. If an OpenAI key already exists, an optional live proof may run without inspecting or printing the value; otherwise record deterministic proof only.

- [ ] **Step 4: Run safety and dependency scans**

Run `rg`/git scans that prove:

- no Gemini code/dependency/env/copy;
- no credential literals or `.env` contents;
- no prompt/image/data-URL/key/cookie logging or persistence fields;
- no browser key/token/provider override controls;
- no dependency or lockfile changes unless explicitly required;
- no generated build, Prisma temp, duplicate-numbered, PEM/key, or deployment artifacts;
- only intended Task 10 files differ; and
- `npm audit` result is recorded, or the exact network/policy limitation is documented without bypass.

- [ ] **Step 5: Request fresh code/spec review**

Generate a review package from `b7f8fca` to current HEAD plus working diff, then dispatch one fresh reviewer with the Task 10 brief, approved spec, runnable plan, report, and package. Require read-only review and severity-ranked Critical/Important/Minor findings.

- [ ] **Step 6: Address every Critical/Important through RED→GREEN**

For each valid finding, reproduce it with a focused failing test, observe the expected RED, apply the minimal fix, rerun the focused test to GREEN, and rerun the affected package suite. Record residual Minors in the report and request re-review until no Critical/Important remains.

- [ ] **Step 7: Run final fresh verification and finish locally**

Repeat the full focused/full/Prisma/lint/typecheck/build/post-build/diff/scans after the last source change. Stage only Task 10 tracked files, inspect the cached diff, and commit review fixes with a focused message. Do not push. Report all Task 10 commit SHAs, exact test counts, migration name, evidence/report paths, audit result/limitation, review disposition, scans, residual risk, and branch status directly to `/root`.

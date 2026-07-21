# Task 10 Reconstruction Jobs Design

**Date:** 2026-07-21

**Status:** Approved for implementation

## Scope

Task 10 turns a server-authoritative readiness transition from Task 7 into one
validated architecture revision. It adds durable reconstruction job execution,
room and debug HTTP APIs, the browser reconstruction hook, and the diagnostic
bench. It consumes Task 8's deterministic compiler and Task 9's bounded
OpenAI-first, Anthropic-fallback provider boundary.

Task 10 does not add graph editing, architect patches, deployment synthesis,
cloud execution, new provider types, or browser-supplied credentials. It never
persists a whiteboard image or provider prompt.

## Public contracts

`packages/contracts/src/reconstruction.ts` owns strict schemas for:

- the room reconstruction request;
- the public job envelope and terminal error;
- provider identity metadata;
- reconstruction analysis and successful result;
- the debug request and response;
- the working architecture and layout values written to Yjs; and
- stable Yjs architecture keys.

The room request is exactly:

```ts
{
  imageDataUrl: string;
  mimeType: "image/png";
  requirements: RequirementsProfile;
  sourceSnapshotVersion: number;
}
```

The successful result contains the job trace ID, selected provider and model,
validated intent, compiler diagnostics, stage decision, deployment plan, and
architecture revision ID. Public job responses include the job ID, source
snapshot version, state, and either a terminal result or a stable public error.
They exclude internal trace IDs while nonterminal, attempt identifiers, image
digests, lease facts, raw diagnostics, and recorder details.

Task 7's `TransitionClaim` gains a required `sourceSnapshotVersion`. Both a new
claim and an idempotent duplicate response return the exact durable
`TransitionJob.sourceRevision`; the server never derives this value from a
client request.

## Durable model and migration

A new forward Prisma migration extends `TransitionState` with `publishing` and
adds the following `TransitionJob` fields:

- `attempt`, a monotonic integer;
- `leaseOwner`, `leaseToken`, and `leaseExpiresAt`;
- current-attempt participant, input digest, and AI trace ID;
- an optional unique architecture revision reference;
- bounded result JSON and redacted diagnostic JSON;
- cleanup and phase-publication completion timestamps; and
- terminal completion time.

The migration adds the indexes needed to find recoverable state and expired
leases. The initial migration remains unchanged.

Attempt participant and digest fields bind only the active attempt. They are
not a permanent job-level restriction. A different eligible voter can reclaim
an expired running attempt with a newly rendered PNG because browser PNG output
is not guaranteed to be byte-identical across clients.

## State machine

### `claimed`

Task 7 has atomically inserted the unique job keyed by room, source snapshot,
and readiness kind, and changed the durable Room phase from `sketch` to
`reconstructing`. The job is waiting for a validated browser capture.

### `running`

One process owns a renewable lease for a provider/compiler attempt. The lease
lasts 30 seconds and is heartbeated every 10 seconds without holding a database
transaction. A fresh lease is never replaced: every concurrent POST returns
HTTP 202 with the same public in-flight job envelope, regardless of caller or
payload.

An expired lease may be reclaimed by any currently authorized participant who
appears among the voters in the exact persisted source snapshot. Reclaim uses a
new lease token, attempt number, attempt-scoped input digest, and attempt AI
trace. The prior process can finish its provider call, but its token can no
longer mutate the job or create a revision.

### `publishing`

The provider and compiler have completed, and the unique revision, history
event, bounded result, and revision link have committed. Provider execution is
never repeated from this state. A fresh owner finishes Yjs publication; an
expired lease can be reclaimed without an image.

### `succeeded`

The architecture revision is current and the durable Room phase is
`architect`. The terminal result is immutable. Replays return the stored
result. A missing post-commit Yjs phase mirror remains repairable and does not
change the durable terminal outcome.

### `failed`

A provider, compiler, or application failure has been reduced to a stable
public error. While readiness cleanup is pending, the durable Room remains
`reconstructing`, so Task 7 keeps new readiness voting closed. After the
old-source readiness value is removed and the sketch phase is durably mirrored,
a short conditional transaction records cleanup completion and changes Room to
`sketch`. Retrying reconstruction then requires a new readiness vote, source
snapshot, and transition job.

Provider calls are intentionally at-least-once across process death. If a
provider completed but the process died before the fenced revision transaction,
a reclaimed attempt calls the provider again. This can repeat provider cost,
but only one revision and one reconstruction history event can commit.

## Claim, lease, and fencing transactions

All database transactions are short and contain no provider or Yjs work.

Before claim, the service validates the public request, exact Yjs snapshot,
authorization, readiness facts, and PNG. A serializable claim transaction then:

1. loads the unique Task 7 job for the room and source version;
2. returns its terminal result/error or fresh in-flight state when applicable;
3. conditionally takes a claimed or expired-running lease;
4. closes an abandoned running `AiRun` with a stable safe code when possible;
5. increments the attempt and stores only current-attempt binding facts; and
6. creates the attempt `AiRun` in `running` state.

Every later job mutation includes the current lease token. The token is the
fencing value; worker identity alone is not sufficient.

Each provider attempt uses a trace of the form
`<job-trace>:attempt:<attempt-number>`. Task 9's awaited terminal recorder
conditionally updates only that attempt's running `AiRun`. It receives and
stores only trace ID, task, selected provider, model, terminal status, and an
optional stable error code. A reclaimed stale recorder cannot update the job or
a newer attempt.

## Provider and compiler pipeline

The shared `analyzeReconstruction` boundary performs:

```text
strict PNG/request validation
→ Task 9 provider/failover
→ validated InfrastructureIntent
→ Task 8 deterministic compiler
→ selected provider metadata + compiled analysis
```

The room service wraps this pure pipeline with claims, AiRun persistence,
revision persistence, Yjs publication, and phase changes. The debug service
uses the same pipeline with an in-memory awaited terminal recorder.

Blocking compiler diagnostics prevent revision creation. The failed job stores
only bounded `{ level, code }` facts. It does not persist model-derived names,
paths, suggestions, messages, prompts, or image data.

## Exactly-once revision and history

After provider recording and compilation, one fenced serializable transaction:

1. proves the lease token still owns the running job;
2. allocates the next room revision version;
3. creates one immutable architecture revision;
4. creates one deterministic reconstruction history event;
5. stores the bounded terminal result and unique revision reference; and
6. changes the job to `publishing` while the Room remains `reconstructing`.

The transition job's unique revision reference plus token-fenced state change
prevents duplicate revisions. The history event uses a deterministic ID derived
from the job, so retries cannot duplicate history. Serializable/version races
retry the complete short transaction.

The revision stores the semantic architecture and requirements separately from
a strict initial layout value. The revision's author is AI; the history actor is
the signed participant whose accepted attempt produced the result. Provider
provenance contains only provider name and configured model.

## Yjs ordering and recovery

Architecture publication follows the durable revision commit:

1. clone the live or restored room document;
2. write only `architecture/current` and `architecture-layout/current`;
3. preserve tldraw, requirements, votes, and unrelated maps;
4. persist the candidate snapshot;
5. publish its delta to the live document; and
6. atomically change Room `reconstructing` to `architect` and job
   `publishing` to `succeeded` under the lease fence.

If candidate persistence or live publication fails, the job remains
`publishing`. Replay or startup recovery rebuilds the same candidate from the
stored revision/result and resumes without another provider call or revision.

After durable success, the service mirrors `architect` into Yjs phase metadata,
persists it, and publishes it with bounded retry. `phasePublishedAt` records
completion. Room remains the phase authority if this post-commit mirror fails;
replay and startup recovery repair the mirror idempotently.

Terminal failure first records the job's stable failed result while leaving
Room `reconstructing`. It then clones the document, deletes only the
server-owned `ready` vote for the old source transition, mirrors `sketch`,
persists, and publishes. Only after that succeeds does a short conditional
transaction set `cleanupCompletedAt` and change Room `reconstructing` to
`sketch`. Failure or restart cannot destroy the sketch or requirements, and
replay/startup recovery continues pending cleanup before voting reopens. This
ordering makes it impossible for recovery of an older failed job to erase a
newer readiness vote.

Startup recovery automatically processes only:

- `publishing` jobs with stored revisions/results;
- failed jobs missing readiness/phase cleanup; and
- succeeded jobs missing their Yjs phase mirror.

It never calls a provider for `claimed` or expired `running` jobs because no
image is stored. Those jobs remain client-reclaimable.

## Source snapshot and request validation

The POST service resolves the unique transition job by room and submitted
source version, then cross-checks its ID, room, durable source revision, and
readiness kind. Client-supplied version is never sufficient on its own.

The exact `YjsSnapshot` is decoded and validated. Its server readiness snapshot
must meet the 80 percent threshold, the POST caller must be a durable signed
room member and one of its voters, and the request requirements must deeply
equal that snapshot's validated requirements.

PNG validation is server-owned and occurs before provider invocation:

- MIME is exactly `image/png`;
- the data URL prefix and canonical base64 are exact;
- encoded length is checked before allocating decoded bytes;
- decoded data is at most 5 MiB;
- PNG signature, IHDR-first, IEND-last, unique IHDR, and bounded chunk traversal
  are required;
- width and height are nonzero and at most 4096 each; and
- total pixels are at most 16,777,216.

The maximum canonical base64 payload for 5 MiB is 6,990,508 characters. The
Fastify route body limit is 7,100,000 bytes to include the data URL, requirements,
and JSON framing. The provider request owns the raw data URL only for the
bounded call lifetime. PostgreSQL, Yjs, logs, errors, responses, fixtures, and
debug metadata never receive PNG bytes, base64, or a data URL.

The safety identifier is a domain-separated HMAC using the existing cookie
signing secret and the room/participant identity. It is opaque and within Task
9's length bound. A raw participant ID is never sent to a provider.

## Authorization and HTTP behavior

Routes are:

- `POST /api/rooms/:roomId/reconstruction` — signed durable participant and
  exact-source voter required;
- `GET /api/rooms/:roomId/reconstruction` — discover the current job;
- `GET /api/rooms/:roomId/reconstruction/:jobId` — poll one room-owned job; and
- `POST /api/debug/rooms/:roomId/reconstruction` — authenticated non-mutating
  diagnostic parse when explicitly enabled.

Both GET routes permit a verified durable room member or a verified room-owner
cookie. Every query constrains both room and job. A missing or cross-room job is
404 without leaking existence. Current-job discovery returns only the public
claim/envelope needed for a different eligible voter to recover a
presence-triggered or abandoned transition.

Debug access also requires a valid member or owner credential for the named
room. It never accepts an API key, debug token, provider selection, model name,
prompt, or safety identifier from the browser.

The debug API is registered only when `ENABLE_DEBUG_ROUTES=true` and
`NODE_ENV` is not `production`. The Next `/debug` page applies the same gate and
calls `notFound()` otherwise. Both gates default off.

## Browser orchestration

`useReconstruction` is keyed by transition job ID. It:

1. captures a PNG once per active attempt;
2. reads and validates the shared requirements;
3. submits the server-provided source snapshot version;
4. validates that the response job ID matches its claim;
5. treats HTTP 202 as in-flight and polls with bounded backoff;
6. deduplicates double clicks, effects, reconnects, and terminal replays;
7. retains raw capture data only while the request attempt needs it; and
8. advances local UI only from validated durable terminal responses.

`ReadinessVote` passes a validated atomic claim to the hook. It does not create
reconstruction authority. On remote or restarted reconstructing state, the hook
uses authorized current-claim discovery. A terminal failure returns the UI to
sketch after durable confirmation and allows a new vote.

The diagnostic bench follows the existing warm-white, graphite, sage, and
amber visual system. It accepts a PNG file and workload fields. It never renders
the image or its data URL and never has a key/token input. It displays validated
requirements, provider/model, intent, diagnostics, stage decision, deployment
plan, and semantic architecture JSON in accessible text panels.

## Error policy

Public failures use stable codes and fixed messages. Invalid request, source,
MIME, PNG, requirements, or membership facts never reach a provider. Provider
errors map to a stable availability response. Blocking compiler output maps to
`RECONSTRUCTION_INVALID`. Lease conflicts return an in-flight envelope rather
than exposing an internal error.

No error surface, log, AiRun, job result, history event, debug metadata, or API
response contains prompts, PNG data, data URLs, API keys, provider secrets,
cookies, SDK responses, raw SDK errors, or arbitrary thrown messages. Logging
uses stable codes and the existing safe error summarizer only.

## Testing and Milestone 3 evidence

Strict RED-to-GREEN tests cover:

- transition claim source-version equality for the winner and duplicate;
- request and result contracts;
- every PNG encoding, size, structure, and dimension boundary;
- exact snapshot readiness, voter, requirements, room, and version binding;
- concurrent POST, fresh in-flight behavior, stale reclaim, heartbeat, fencing,
  and late recorder behavior;
- provider-at-least-once recovery with exactly one revision/history result;
- success, blocking compiler output, provider outage, and terminal replay;
- all architecture-publication, failure-cleanup, and phase-mirror failure and
  restart windows;
- a crash after failure recording but before cleanup, proving Room remains
  reconstructing, no new readiness vote can be accepted, recovery removes only
  the old readiness value, and voting reopens only after cleanup completion;
- startup recovery scope proving it never retries AI without bytes;
- member, owner, forged, missing, and cross-room route authorization;
- debug route/page gates and zero durable/Yjs mutation;
- hook double-submit, retry, polling, claim mismatch, unmount, and failure
  behavior; and
- DebugBench accessibility, safe fields, and output sections.

Milestone 3 uses a deterministic injected provider when no existing local
OpenAI key is present. A live OpenAI proof is optional only when the key already
exists; the implementation never asks for, prints, logs, or persists it.

Final verification includes focused reconstruction, provider, compiler,
contracts, server, and web tests; opt-in PostgreSQL concurrency/restart tests;
Prisma generation/schema/migration validation; lint; typecheck; production
build; fresh post-build typecheck; browser/API/restart/outage evidence; and
dependency, provider, Gemini, credential, prompt, raw-image, logging, artifact,
and diff scans. Task 10 is committed locally and is not pushed without separate
Milestone 3 approval.

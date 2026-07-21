# AI Architect Chat and Patch Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable AI architect explanation and reviewable graph-patch turns whose application is atomic with immutable revision creation.

**Architecture:** PostgreSQL is authoritative for architect turns, proposal review, AI run state, and idempotency; Yjs remains authoritative only for the live protected graph. OpenAI-primary/Anthropic-fallback produces one strict explain-or-propose envelope. Applying a proposal performs proposal CAS, room pointer fencing, protected-state CAS, revision/history creation, and Yjs snapshot insertion in one Serializable transaction, then publishes the committed candidate to live Yjs.

**Tech Stack:** TypeScript, Zod, Prisma/PostgreSQL, Yjs, Fastify, React/Next.js, Vitest, OpenAI Responses API, Anthropic structured outputs.

## Global Constraints

- No Gemini provider, shell/CDK/database/AWS tools, live secrets, or raw prompt/output logging.
- AI-generated destructive operations never contain human confirmation; apply requires participant confirmation and rationale.
- Turn/apply/reject requests are idempotent; stale `thinking` turns fail conditionally with `TURN_INTERRUPTED` and are never replayed automatically.
- Participant or verified owner may create/list turns; only a durable participant may apply or reject.
- HTTP responses never overwrite protected Yjs graph state.

---

### Task 1: Strict architect contracts and durable schema

**Files:**
- Create: `packages/contracts/src/architect.ts`
- Create: `packages/contracts/src/architect.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/server/prisma/schema.prisma`
- Create: `apps/server/prisma/migrations/0003_architect_turns/migration.sql`

**Interfaces:**
- Produces: strict `ArchitectTurnRequestSchema`, `ArchitectTurnSchema`, `ArchitectTurnListSchema`, `ApplyArchitectPatchRequestSchema`, and `RejectArchitectPatchRequestSchema`.
- Produces: durable fields for actor, idempotency, source protected state, terminal result, and bounded failure/review metadata.

- [ ] Write tests proving explanation operations are empty, proposals are non-empty, destructive proposal operations omit confirmation, requests are strict/bounded, and every turn state parses.
- [ ] Run `npm test --workspace @architect/contracts -- architect.test.ts`; expect missing-module failure.
- [ ] Implement the strict schemas and exports.
- [ ] Add migration columns and unique indexes for room/principal/idempotency plus applied revision identity.
- [ ] Run contract tests and typecheck; expect all green.
- [ ] Commit with `feat: define architect turn contracts`.

### Task 2: Durable turn repository, recorder, idempotency, and liveness

**Files:**
- Create: `apps/server/src/architecture/architectProposal.repository.ts`
- Create: `apps/server/src/architecture/architectProposal.repository.test.ts`

**Interfaces:**
- Produces: `createThinking`, `recordAiTerminal`, `completeTurn`, `failTurn`, `interruptStaleThinking`, `listTurns`, `rejectProposal`, and `applyProposalRevision`.
- `createThinking` atomically inserts the turn and running `AiRun`, or returns the existing idempotent turn.

- [ ] Write memory-repository tests for exactly-once creation, terminal recorder fencing, answered/proposal/failed transitions, stale-thinking interruption, retry without provider replay, repeat rejection, and opposite terminal-action conflict.
- [ ] Run the focused repository test; expect missing-module failure.
- [ ] Implement bounded Serializable retries and conditional state updates.
- [ ] Verify stale thinking changes only `thinking` older than the cutoff to `failed/TURN_INTERRUPTED` and its running AiRun to failed.
- [ ] Run focused tests and server typecheck.
- [ ] Commit with `feat: persist architect turns`.

### Task 3: Strict AI turn protocol and orchestration

**Files:**
- Create: `apps/server/src/architecture/architect.protocol.ts`
- Create: `apps/server/src/architecture/architect.service.ts`
- Create: `apps/server/src/architecture/architect.service.test.ts`
- Create: `apps/server/src/architecture/architect.runtime.ts`

**Interfaces:**
- Consumes: Task 9 `AiProvider.architect` and failover recorder; Task 11 active document registry and graph engine.
- Produces: `runTurn`, `listTurns`, `applyPatch`, and `rejectPatch`.

- [ ] Write failing service tests for explanation, valid SQS proposal, invalid semantic output, OpenAI-to-Anthropic fallback recording, idempotent retries, recorder failure, and stale-thinking interruption without replay.
- [ ] Run focused tests and confirm intended failures.
- [ ] Implement a strict root-object protocol with bounded frozen graph/requirements/history input and explain-or-propose output.
- [ ] Freeze protected state under the room lock, release before provider work, and finalize only the matching thinking turn.
- [ ] Run service/provider/failover tests and server typecheck.
- [ ] Commit with `feat: orchestrate architect turns`.

### Task 4: Atomic proposal apply and rejection

**Files:**
- Modify: `apps/server/src/architecture/architectProposal.repository.ts`
- Modify: `apps/server/src/architecture/architectProposal.repository.test.ts`
- Modify: `apps/server/src/architecture/architect.service.ts`
- Modify: `apps/server/src/architecture/architect.service.test.ts`

**Interfaces:**
- `applyProposalRevision` returns committed, idempotent, stale revision, working conflict, terminal conflict, or not found.

- [ ] Write failing tests for missing destructive confirmation, stale same-revision state, manual-op wins, proposal-apply wins, duplicate apply, publish failure/restart recovery, and zero partial writes.
- [ ] Run focused tests and confirm the atomicity failures.
- [ ] Compute patched/rebased candidate under the room lock without publishing.
- [ ] In one Serializable transaction fence proposal state, room revision, and latest protected state; create revision, revision event, proposal event, snapshot, and applied proposal state.
- [ ] Publish Yjs only after commit; map conflicts to bounded 409 errors.
- [ ] Run focused repository/service/Task 11 regression tests.
- [ ] Commit with `feat: apply architect patches atomically`.

### Task 5: Authenticated routes and application runtime

**Files:**
- Create: `apps/server/src/architecture/architect.routes.ts`
- Create: `apps/server/src/architecture/architect.routes.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: server composition entry files that construct architecture/reconstruction services.

**Interfaces:**
- Produces: `GET/POST /api/rooms/:roomId/architect/turns`, `POST .../patches/:patchId/apply`, and `POST .../patches/:patchId/reject`.

- [ ] Write failing route tests for participant/owner create/list, participant-only apply/reject, cross-room denial, strict bodies, idempotency, and bounded errors.
- [ ] Run route tests and confirm missing registration failures.
- [ ] Implement server-derived principals/traces and route registration.
- [ ] Add architect runtime using the existing OpenAI-primary/Anthropic-fallback provider configuration and deterministic test provider only outside production.
- [ ] Run app/routes/runtime tests and typecheck.
- [ ] Commit with `feat: expose architect review APIs`.

### Task 6: Architect panel and patch review UI

**Files:**
- Create: `apps/web/src/features/architect/ArchitectPanel.tsx`
- Create: `apps/web/src/features/architect/PatchReviewDialog.tsx`
- Create: `apps/web/src/features/architect/ArchitectPanel.test.tsx`
- Modify: `apps/web/src/features/architecture/GraphEditor.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: Task 1 response contracts and Task 5 routes.
- Produces: explanation chat, durable turn polling, proposal review, destructive confirmation, rejection, apply, and bounded conflict guidance.

- [ ] Write failing UI tests for explanation-only, SQS proposal review, destructive confirmation, rejection, duplicate-submit suppression, remote polling, and HTTP responses never replacing Yjs graph.
- [ ] Run focused web tests and confirm missing-component failures.
- [ ] Implement accessible panel/dialog and integrate it into the architecture sidebar.
- [ ] Refresh turn state by bounded polling and mutation completion; rely on observed Yjs revision for applied graph/history.
- [ ] Run focused web tests and typecheck.
- [ ] Commit with `feat: add architect patch review UI`.

### Task 7: Deterministic PostgreSQL/two-client proof and completion gates

**Files:**
- Create: `apps/server/src/architecture/architect.persistence.integration.test.ts`
- Modify: `apps/server/src/architecture/architect.service.test.ts`

**Interfaces:**
- Proves explanation and SQS proposal/apply without live AI credentials.

- [ ] Write the opt-in PostgreSQL proof using actual Prisma/Fastify/Yjs, two signed participant clients, and deterministic providers.
- [ ] Confirm RED for missing persistence/race behavior.
- [ ] Make only fixes backed by the proof.
- [ ] Verify explanation creates no graph mutation, proposal creates no graph mutation, two clients read the same durable turn, apply converges/history/restarts, duplicate apply is exactly once, both manual-op/apply race orderings have zero losing-side partial writes, and interrupted thinking never replays.
- [ ] Run Prisma generate/validate, focused/full tests, lint, build, pre/post-build typecheck, diff, dependency/security/browser/artifact scans, and independent review.
- [ ] Commit with `test: prove architect patch durability`.

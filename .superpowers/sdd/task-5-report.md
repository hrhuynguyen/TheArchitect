# Task 5 Report: Durable Yjs and Hocuspocus Collaboration

## Status

Implemented durable room-scoped Yjs collaboration on the dedicated `WS_PORT`, authenticated by the existing signed HttpOnly participant cookie. The implementation includes monotonic PostgreSQL snapshots, bounded Hocuspocus persistence, explicit phase/shutdown flushes, transient awareness, browser provider lifecycle, and coordinated HTTP/WebSocket/Prisma shutdown.

Base commit: `4fbe9f280777d2aac782c61a241c099937b9833a`

## Compatibility decision

- Pinned matched `@hocuspocus/server` and `@hocuspocus/provider` `3.4.4`, the newest stable 3.x release published by npm.
- npm metadata for 3.4.4 declares no restrictive `engines` field and peers on Yjs `^13.6.8` / y-protocols `^1.0.6`, preserving the approved Node `>=20` contract.
- Did not use current Hocuspocus v4 because its official server package requires Node `>=22`.
- Pinned `yjs` `13.6.31`, `y-protocols` `1.0.7`, and test `ws` `8.21.1`.
- Adapted to the v3 API: `IncomingHttpHeaders`, `connectionConfig`, `context`/`socketId`, and v3 `Server` lifecycle.
- Added adapter ownership of the underlying HTTP server's bind-error event because v3 `Server.listen()` does not reject on `EADDRINUSE`.
- Added adapter-owned dirty snapshot retention because v3 unloads a document after a failed `onStoreDocument` call and otherwise surfaces an unhandled rejection.

## TDD evidence

### Initial RED

Command:

```text
npm test --workspace @architect/server -- yjs.repository.test.ts hocuspocus.test.ts lifecycle.test.ts
```

Observed failures:

- missing `yjs.repository`, `hocuspocus`, awareness, and snapshot modules;
- lifecycle did not start or destroy collaboration;
- snapshot/auth/lifecycle expectations failed for the intended missing behavior.

### Repository GREEN

The focused repository suite passed 5 tests covering:

- real Yjs update-byte recovery from only the latest snapshot;
- empty-room `Y.Doc` creation;
- reason and monotonic version storage;
- concurrent unique-version conflict retry;
- non-retryable database failure propagation.

The repository uses a serializable Prisma transaction and bounded retry for `P2002` and `P2034`, so aggregate-plus-insert races cannot produce duplicate `(roomId, version)` values.

### Hocuspocus/awareness/lifecycle RED → GREEN

Captured RED for missing/tampered/cross-room/unknown participant credentials, awareness lifecycle, phase/shutdown flush, real provider sync/recovery, and HTTP/WebSocket shutdown ownership.

Additional v3 lifecycle RED reproductions:

- occupied port: actual second listener timed out and emitted uncaught `EADDRINUSE` because upstream `Server.listen()` never rejected;
- failed disconnect store: actual repository rejection logged from `onStoreDocument`, produced an unhandled rejection, and allowed unload.

GREEN behavior:

- one-shot underlying bind-error listener rejects deterministically and is removed on success/error;
- lifecycle does not start HTTP after a WebSocket bind failure and still closes collaboration, Fastify, and Prisma;
- failed snapshot writes remain dirty, are retained across unload, merged into a new Y.Doc on reconnect, and retried on shutdown without an unbounded retry timer;
- Hocuspocus hook persistence failures are reported through a generic callback rather than leaking as unhandled protocol errors;
- shutdown failures still permit Fastify and Prisma cleanup.

### Contracts/client RED → GREEN

Captured missing-module RED for the exact awareness contract, `createRoomCollab`, and `usePresence`.

GREEN behavior:

- strict awareness schema: `participantId`, `name`, `color`, optional finite `{x,y}` cursor, valid room `phase`, ISO `lastSeenAt`, and no extra fields;
- configured `NEXT_PUBLIC_WS_URL` or same-origin `ws:`/`wss:` derivation, with credentials rejected;
- room ID remains exact Hocuspocus protocol data and is never interpolated into the URL;
- no auth token or secret is placed in provider configuration;
- provider/document destroy is idempotent;
- presence publishes validated shape, heartbeats at one bounded interval, and clears its interval/local awareness on cleanup.

## Persistence, authentication, and awareness evidence

- Snapshots use `Y.encodeStateAsUpdate`; restore uses `Y.applyUpdate` on the latest version.
- Real two-provider WebSocket test syncs shared state, observes an immediate phase snapshot, observes a later debounced snapshot, keeps one client connected through shutdown, verifies final reason `shutdown`, starts a fresh server, reconnects, and restores the durable value.
- Real missing/tampered/cross-room/unknown credentials all receive the same Hocuspocus `permission-denied`; valid credentials reconnect.
- Authentication requires the exact room-named cookie, verifies its HMAC/room claim, and confirms the participant still exists for `(id, roomId)`.
- Registry membership/name/color comes from the authenticated database participant. Client awareness can update only validated cursor/phase for an already-connected participant ID.
- Awareness connect/change/heartbeat/multi-socket disconnect/stale cleanup are covered; cleanup timer is cleared on destroy.
- Awareness profiles/cursors are never written into Yjs snapshot bytes; the real persisted document asserts no `awareness` shared type.

## Files

Created:

- `apps/server/src/collab/yjs.repository.ts`
- `apps/server/src/collab/yjs.repository.test.ts`
- `apps/server/src/collab/yjs.repository.integration.test.ts`
- `apps/server/src/collab/snapshot.service.ts`
- `apps/server/src/collab/awareness.registry.ts`
- `apps/server/src/collab/hocuspocus.ts`
- `apps/server/src/collab/hocuspocus.test.ts`
- `apps/web/src/features/workspace/collab.ts`
- `apps/web/src/features/workspace/collab.test.ts`
- `apps/web/src/features/workspace/usePresence.ts`
- `apps/web/src/features/workspace/usePresence.test.tsx`
- `packages/contracts/src/collaboration.ts`
- `packages/contracts/src/collaboration.test.ts`

Modified:

- `.env.example`
- `apps/server/package.json`
- `apps/server/src/index.ts`
- `apps/server/src/lifecycle.ts`
- `apps/server/src/lifecycle.test.ts`
- `apps/web/package.json`
- `package-lock.json`
- `packages/contracts/package.json`
- `packages/contracts/src/index.ts`

## Verification

Final focused command:

```text
npm test --workspace @architect/server -- yjs.repository.test.ts yjs.repository.integration.test.ts hocuspocus.test.ts lifecycle.test.ts
npm test --workspace @architect/contracts -- collaboration.test.ts
npm test --workspace @architect/web -- collab.test.ts usePresence.test.tsx
npm run typecheck --workspace @architect/server
npm run typecheck --workspace @architect/contracts
npm run typecheck --workspace @architect/web
```

Result: server 29 passed / 1 opt-in skipped, contracts 5 passed, web 7 passed; all affected typechecks passed.

Final full command:

```text
npm test && npm run typecheck && npm run build
```

Result:

- server: 88 passed / 3 skipped;
- web: 50 passed;
- contracts: 6 passed;
- total: 144 passed / 3 opt-in skipped;
- server, web, contracts, infra, and UI typechecks passed;
- server TypeScript build and Next 16 production build passed.

PostgreSQL adapter integration is opt-in because no isolated test database was supplied:

```text
RUN_YJS_DATABASE_TESTS=true \
YJS_TEST_DATABASE_URL=postgresql://... \
npm test --workspace @architect/server -- yjs.repository.integration.test.ts
```

The test creates and cleans its own room and snapshots, exercises four concurrent real Prisma writers, verifies versions `1..4`, disconnects, and reloads the latest Yjs snapshot.

`git diff --check` passed.

## Concerns

- Hocuspocus 3.4.4 is intentionally selected for Node 20 compatibility; upgrading to v4 requires an approved Node 22 runtime change and hook migration.
- Hocuspocus v3 awareness callbacks do not reliably expose the sending connection as an origin. Membership and name/color remain server-authoritative, while cursor/phase are treated as transient, non-authorization state and accepted only for participant IDs already in the authenticated room registry.
- The optional real PostgreSQL test was added but not executed in this environment because `YJS_TEST_DATABASE_URL` was not provided.
- `npm audit --omit=dev` reports two moderate findings under Next's bundled PostCSS. The path is unrelated to the added Hocuspocus/Yjs dependencies, and npm's proposed force fix would downgrade Next to 9.3.3, so no unsafe forced dependency change was made.

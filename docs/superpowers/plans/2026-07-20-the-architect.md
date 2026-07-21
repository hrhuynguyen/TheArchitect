# The Architect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish a complete VibeCloud-style multiplayer workspace that turns collaborative sketches into validated AWS architectures and safely deploys approved revisions to LocalStack or a configured AWS account.

**Architecture:** Use an npm-workspace monorepo with a Next.js 16 web application, a long-running Fastify/Hocuspocus server, shared Zod contracts, a deterministic infrastructure compiler, and reusable UI primitives. PostgreSQL and Prisma persist room state, Yjs snapshots, revisions, history, AI runs, and deployment jobs; OpenAI is the primary AI provider and Anthropic is the only fallback.

**Tech Stack:** Node.js 20+, npm workspaces, TypeScript, Next.js 16 App Router, React, Fastify 5, Hocuspocus, Yjs, Prisma, PostgreSQL, Zod, tldraw, React Flow, OpenAI Responses API, Anthropic SDK, AWS CDK, AWS SDK v3, LocalStack, Docker Compose, Vitest, Testing Library, Playwright, and axe.

## Global Constraints

- Use the original Guided Workspace design: persistent Sketch, Architect, and Deploy rail; warm white and graphite neutrals; restrained sage success and amber risk states.
- Use Next.js 16 App Router. Do not restore the reference repository's stale Vite entrypoints.
- Use PostgreSQL through Prisma for durable state; live cursors remain transient Yjs awareness.
- Use OpenAI Responses API as the default for vision and architect tools. Anthropic is the only fallback. Do not add Gemini dependencies, keys, code paths, or environment variables.
- Keep OpenAI and Anthropic model names separately configurable; initialize both OpenAI model variables to `gpt-5.6`.
- Store all secrets server-side. Ignore every `.env*` file except `.env.example`; never place AI or AWS credentials in browser bundles, Yjs, PostgreSQL, logs, fixtures, or Git history.
- Use frictionless guest rooms. Signed participant cookies identify voters; a hashed, room-scoped owner token authorizes real AWS execution.
- LocalStack is the default deployment target. Real AWS uses the default credential chain and optional `AWS_DEPLOY_ROLE_ARN`; never accept browser-submitted AWS access keys.
- Real AWS execution requires team consensus, successful synthesis, a reviewed CloudFormation change set, and explicit owner confirmation.
- Generate infrastructure only from validated allowlisted contracts. Unsupported deployment resources must emit blocking diagnostics rather than placeholder constructs.
- Separate the semantic architecture graph from React Flow layout.
- Every external job is idempotent and traceable. Persist state before and after provider and cloud operations.
- Each task follows test-driven development, ends with focused verification, and is committed separately. Each milestone must be runnable and demonstrated before the next begins.
- Create the GitHub repository as `TheArchitect`; keep it private initially because visibility was not specified. Push verified commits while excluding secrets and generated artifacts.
- Obtain user approval before any major architectural deviation from the accepted design specification.

---

## Planned File Map

### Repository configuration

- `package.json` — npm workspaces and root build, test, lint, database, and development scripts.
- `package-lock.json` — reproducible dependency graph committed after every dependency change.
- `tsconfig.base.json` — strict shared TypeScript settings.
- `vitest.workspace.ts` — package-aware unit and integration test projects.
- `playwright.config.ts` — two-browser end-to-end configuration.
- `docker-compose.yml` — PostgreSQL and pinned LocalStack plus optional web/server profiles.
- `.env.example` — documented non-secret configuration.
- `.github/workflows/ci.yml` — install, generated-client check, lint, typecheck, unit, integration, build, and Playwright gates.

### `apps/web`

- `apps/web/src/app/layout.tsx` and `globals.css` — root layout, fonts, design tokens, resets, focus, and reduced-motion rules.
- `apps/web/src/app/page.tsx` — landing page.
- `apps/web/src/app/start/page.tsx` — create/join/solo onboarding.
- `apps/web/src/app/room/[roomId]/page.tsx` — server entrypoint for a room.
- `apps/web/src/features/rooms/*` — API client, guest profile, and room bootstrapping.
- `apps/web/src/features/workspace/*` — Guided Workspace shell, phase rail, member presence, responsive sheets.
- `apps/web/src/features/sketch/*` — tldraw binding, requirements, readiness vote, capture.
- `apps/web/src/features/architecture/*` — React Flow adapter, resource palette, provenance, revision history.
- `apps/web/src/features/architect/*` — chat, patch preview, tool-operation results.
- `apps/web/src/features/deploy/*` — target selection, vote, synth/change-set review, owner confirmation, logs.
- `apps/web/src/features/debug/*` — parser/deployment diagnostic bench.

### `apps/server`

- `apps/server/prisma/schema.prisma` and `prisma/migrations/*` — durable data model and SQL history.
- `apps/server/src/app.ts` — Fastify construction and plugin registration without listening.
- `apps/server/src/index.ts` — process startup and graceful shutdown.
- `apps/server/src/config/env.ts` — strict environment parsing and secret redaction metadata.
- `apps/server/src/db/client.ts` — Prisma singleton and lifecycle.
- `apps/server/src/auth/*` — participant signing, owner-token hashing, cookie helpers, authorization guards.
- `apps/server/src/rooms/*` — room service, routes, DTO mapping.
- `apps/server/src/collab/*` — Yjs repository, snapshot persistence, Hocuspocus hooks, awareness registry.
- `apps/server/src/reconstruction/*` — idempotent job service, provider orchestration, routes.
- `apps/server/src/ai/*` — provider interface, OpenAI adapter, Anthropic adapter, failover policy.
- `apps/server/src/architecture/*` — revision service, graph-operation service, architect routes.
- `apps/server/src/deploy/*` — job state machine, artifact runner, LocalStack adapter, CloudFormation adapter, routes.
- `apps/server/src/observability/*` — trace IDs, structured error mapping, and redaction.

### Shared packages

- `packages/contracts/src/*` — Zod schemas for rooms, collaboration, requirements, infrastructure intent, graph, history, AI, and deployment.
- `packages/infra/src/catalog.ts` — resource capabilities and deployment support matrix.
- `packages/infra/src/staging.ts` — deterministic workload scoring, minimal inference, and upgrade proposals.
- `packages/infra/src/compiler.ts` — intent-to-semantic-graph compiler.
- `packages/infra/src/operations.ts` — graph-operation validation and transactional application.
- `packages/infra/src/cdk/*` — CDK source generation and graph wiring.
- `packages/ui/src/*` — buttons, fields, dialogs, status badges, shell layout, and tokens.
- `packages/config/*` — shared lint, TypeScript, and test presets.

---

## Milestone 0 — Runnable Monorepo and Durable Health Check

### Task 1: Bootstrap the npm workspace and application shells

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `.env.example`
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/next.config.ts`
- Create: `apps/web/src/app/layout.tsx`
- Create: `apps/web/src/app/page.tsx`
- Create: `apps/web/src/app/globals.css`
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/src/app.ts`
- Create: `apps/server/src/index.ts`
- Create: `apps/server/src/observability/errors.ts`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/workspace.test.ts`
- Create: `packages/infra/package.json`
- Create: `packages/infra/src/index.ts`
- Create: `packages/ui/package.json`
- Create: `packages/ui/src/index.ts`
- Create: `packages/config/package.json`

**Interfaces:**
- Produces: npm workspaces `@architect/web`, `@architect/server`, `@architect/contracts`, `@architect/infra`, `@architect/ui`, and `@architect/config`.
- Produces: root commands `dev`, `build`, `typecheck`, `test`, `test:e2e`, `db:generate`, and `db:migrate`.
- Produces: `APP_NAME: "The Architect"` and `CONTRACT_VERSION: "architect/v1"` from `@architect/contracts`.
- Produces: `PublicError(code: string, message: string, statusCode = 400, details?: unknown)` for stable route errors used by later tasks.

- [ ] **Step 1: Write the failing workspace contract test**

```ts
// packages/contracts/src/workspace.test.ts
import { describe, expect, it } from "vitest";
import { APP_NAME, CONTRACT_VERSION } from "./index";

describe("workspace contract", () => {
  it("exposes stable product identifiers", () => {
    expect(APP_NAME).toBe("The Architect");
    expect(CONTRACT_VERSION).toBe("architect/v1");
  });
});
```

- [ ] **Step 2: Run the test to verify the workspace is absent**

Run: `npm test --workspace @architect/contracts`

Expected: FAIL because the workspace package and test runner do not exist yet.

- [ ] **Step 3: Create the workspace manifests and minimal exports**

Use this root shape and commit the lockfile produced by installation:

```json
{
  "name": "the-architect",
  "private": true,
  "version": "0.1.0",
  "workspaces": ["apps/*", "packages/*"],
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "concurrently -n web,server \"npm run dev --workspace @architect/web\" \"npm run dev --workspace @architect/server\"",
    "build": "npm run build --workspaces --if-present",
    "lint": "npm run lint --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "test:e2e": "playwright test",
    "db:generate": "npm run db:generate --workspace @architect/server",
    "db:migrate": "npm run db:migrate --workspace @architect/server"
  }
}
```

```ts
// packages/contracts/src/index.ts
export const APP_NAME = "The Architect" as const;
export const CONTRACT_VERSION = "architect/v1" as const;
```

```ts
// apps/server/src/observability/errors.ts
export class PublicError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "PublicError";
  }
}
```

The web root renders `The Architect`, and the Fastify app exposes `GET /api/health` returning `{ "ok": true, "service": "architect-server" }`.

- [ ] **Step 4: Install and verify the empty vertical slice**

Run: `npm install`

Run: `npm run test && npm run typecheck && npm run build`

Expected: all workspace tests pass, all packages typecheck, the Next.js production build succeeds, and the server compiles.

- [ ] **Step 5: Smoke-test both processes**

Run server: `npm run dev --workspace @architect/server`

Run web separately: `npm run dev --workspace @architect/web`

Expected: `curl http://localhost:3001/api/health` returns the health JSON, and `http://localhost:3000` renders the product name.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json vitest.workspace.ts .env.example apps packages
git commit -m "chore: bootstrap The Architect monorepo"
```

- [ ] **Step 7: Ensure the private GitHub remote exists and push the verified foundation**

```bash
git remote get-url origin
gh repo create TheArchitect --private --source=. --remote=origin --push
git push origin main
```

Run `gh repo create` only when `git remote get-url origin` reports that no remote exists. Expected: `origin` points to the authenticated user's private `TheArchitect` repository and `main` contains the design and foundation commits without ignored artifacts.

### Task 2: Add validated environment configuration and PostgreSQL persistence

**Files:**
- Create: `docker-compose.yml`
- Create: `apps/server/prisma/schema.prisma`
- Create: `apps/server/prisma/migrations/0001_initial/migration.sql`
- Create: `apps/server/src/config/env.ts`
- Create: `apps/server/src/config/env.test.ts`
- Create: `apps/server/src/db/client.ts`
- Create: `apps/server/src/db/health.ts`
- Create: `apps/server/src/db/health.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `parseEnv(input: NodeJS.ProcessEnv): ServerEnv`.
- Produces: `prisma: PrismaClient` and `databaseHealth(): Promise<{ ok: true }>`.
- Produces: Prisma models `Room`, `Participant`, `YjsSnapshot`, `ArchitectureRevision`, `HistoryEvent`, `AiRun`, `ArchitectProposal`, `TransitionJob`, `DeployJob`, and `DeployLog` with enums matching the design specification.
- Produces: `GET /api/ready` returning 200 only when PostgreSQL is reachable.

- [ ] **Step 1: Write failing environment and readiness tests**

```ts
it("rejects missing owner-token pepper", () => {
  expect(() => parseEnv({ DATABASE_URL: "postgresql://db/test" })).toThrow(
    "OWNER_TOKEN_PEPPER",
  );
});

it("reports database readiness", async () => {
  prisma.$queryRaw = vi.fn().mockResolvedValue([{ value: 1 }]);
  await expect(databaseHealth(prisma)).resolves.toEqual({ ok: true });
});
```

- [ ] **Step 2: Run focused tests to verify failure**

Run: `npm test --workspace @architect/server -- env.test.ts health.test.ts`

Expected: FAIL because `parseEnv` and `databaseHealth` do not exist.

- [ ] **Step 3: Implement strict environment parsing and the complete initial Prisma schema**

The environment schema must include these server-only values:

```ts
const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HTTP_PORT: z.coerce.number().int().positive().default(3001),
  WS_PORT: z.coerce.number().int().positive().default(3002),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  COOKIE_SIGNING_SECRET: z.string().min(32),
  OWNER_TOKEN_PEPPER: z.string().min(32),
  OPENAI_API_KEY: z.string().default(""),
  AI_PROVIDER: z.enum(["openai", "test"]).default("openai"),
  OPENAI_VISION_MODEL: z.string().default("gpt-5.6"),
  OPENAI_AGENT_MODEL: z.string().default("gpt-5.6"),
  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_MODEL: z.string().default(""),
  ENABLE_DEBUG_ROUTES: z.coerce.boolean().default(false),
  LOCALSTACK_URL: z.string().url().default("http://localhost:4566"),
  AWS_REGION: z.string().default("us-east-1"),
  AWS_ALLOWED_REGIONS: z.string().default("us-east-1"),
  AWS_STACK_PREFIX: z.string().regex(/^[A-Za-z][A-Za-z0-9-]+$/).default("architect"),
  AWS_DEPLOY_ROLE_ARN: z.string().default(""),
});
```

The Prisma schema must define every durable entity listed under Interfaces, use UUID primary keys, cascading room deletion, ordered deploy logs, JSON columns for semantic documents, and uniqueness on `(roomId, version)` for snapshots and revisions.

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum RoomMode { shared solo }
enum RoomPhase { sketch reconstructing architect deploy }
enum TransitionKind { ready }
enum TransitionState { claimed running succeeded failed }
enum DeployTarget { localstack aws }
enum DeployState { queued synthesizing creating_change_set awaiting_owner executing succeeded failed cancelled }

model Room {
  id                String   @id @default(uuid())
  mode              RoomMode
  phase             RoomPhase @default(sketch)
  ownerTokenHash    String
  currentRevisionId String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  expiresAt         DateTime?
  participants      Participant[]
  snapshots         YjsSnapshot[]
  revisions         ArchitectureRevision[]
  history           HistoryEvent[]
  aiRuns            AiRun[]
  architectProposals ArchitectProposal[]
  transitions       TransitionJob[]
  deployJobs        DeployJob[]
}

model Participant {
  id        String   @id @default(uuid())
  roomId    String
  name      String
  color     String
  joinedAt  DateTime @default(now())
  lastSeenAt DateTime @default(now())
  room      Room     @relation(fields: [roomId], references: [id], onDelete: Cascade)
  @@index([roomId])
}

model YjsSnapshot {
  id        String   @id @default(uuid())
  roomId    String
  version   Int
  payload   Bytes
  reason    String
  createdAt DateTime @default(now())
  room      Room     @relation(fields: [roomId], references: [id], onDelete: Cascade)
  @@unique([roomId, version])
}

model ArchitectureRevision {
  id           String   @id @default(uuid())
  roomId       String
  version      Int
  architecture Json
  layout       Json
  requirements Json
  stage        String
  authorType   String
  authorId     String?
  rationale    String
  createdAt    DateTime @default(now())
  room         Room     @relation(fields: [roomId], references: [id], onDelete: Cascade)
  deployJobs   DeployJob[]
  @@unique([roomId, version])
}

model HistoryEvent {
  id        String   @id @default(uuid())
  roomId    String
  kind      String
  status    String
  actorType String
  actorId   String?
  title     String
  summary   String?
  details   Json?
  traceId   String?
  createdAt DateTime @default(now())
  room      Room     @relation(fields: [roomId], references: [id], onDelete: Cascade)
  @@index([roomId, createdAt])
}

model AiRun {
  id          String   @id @default(uuid())
  roomId      String?
  traceId     String   @unique
  task        String
  provider    String
  model       String
  status      String
  tokenMeta   Json?
  errorCode   String?
  startedAt   DateTime @default(now())
  finishedAt  DateTime?
  room        Room?    @relation(fields: [roomId], references: [id], onDelete: Cascade)
}

model ArchitectProposal {
  id             String   @id @default(uuid())
  roomId         String
  baseRevisionId String
  operations     Json
  responseText   String
  state          String   @default("proposal_ready")
  traceId        String   @unique
  createdAt      DateTime @default(now())
  reviewedAt     DateTime?
  room           Room     @relation(fields: [roomId], references: [id], onDelete: Cascade)
  @@index([roomId, createdAt])
}

model TransitionJob {
  id             String          @id @default(uuid())
  roomId         String
  sourceRevision Int
  kind           TransitionKind
  state          TransitionState @default(claimed)
  traceId        String          @unique
  errorCode      String?
  createdAt      DateTime        @default(now())
  updatedAt      DateTime        @updatedAt
  room           Room            @relation(fields: [roomId], references: [id], onDelete: Cascade)
  @@unique([roomId, sourceRevision, kind])
}

model DeployJob {
  id             String       @id @default(uuid())
  roomId         String
  revisionId     String
  target         DeployTarget
  state          DeployState  @default(queued)
  traceId        String       @unique
  region         String?
  stackName      String?
  changeSetName  String?
  approvalFacts  Json
  errorCode      String?
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt
  finishedAt     DateTime?
  room           Room         @relation(fields: [roomId], references: [id], onDelete: Cascade)
  revision       ArchitectureRevision @relation(fields: [revisionId], references: [id], onDelete: Restrict)
  logs           DeployLog[]
  @@index([roomId, createdAt])
}

model DeployLog {
  id        String   @id @default(uuid())
  jobId     String
  sequence  Int
  stage     String
  line      String
  createdAt DateTime @default(now())
  job       DeployJob @relation(fields: [jobId], references: [id], onDelete: Cascade)
  @@unique([jobId, sequence])
}
```

- [ ] **Step 4: Generate Prisma, migrate, and pass focused tests**

Run: `docker compose up -d postgres`

Run: `npm run db:generate && npm run db:migrate`

Run: `npm test --workspace @architect/server -- env.test.ts health.test.ts`

Expected: Prisma generation and migration succeed; focused tests pass.

- [ ] **Step 5: Verify the durable health slice**

Run: `npm run dev --workspace @architect/server`

Expected: `/api/health` returns 200 without dependencies; `/api/ready` returns 200 with PostgreSQL running and 503 after PostgreSQL is stopped.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml .env.example apps/server
git commit -m "feat: add durable server foundation"
```

**Milestone 0 checkpoint:** From a fresh clone, `.env.example` can be copied to `.env`, PostgreSQL can be started, migrations run, web built, and both health endpoints demonstrated. Push the two verified commits to `origin/main`.

---

## Milestone 1 — Persistent Guest Rooms and Guided Workspace Shell

### Task 3: Implement participant identity, owner credentials, and room APIs

**Files:**
- Create: `apps/server/src/auth/participant.ts`
- Create: `apps/server/src/auth/ownerToken.ts`
- Create: `apps/server/src/auth/cookies.ts`
- Create: `apps/server/src/auth/auth.test.ts`
- Create: `apps/server/src/rooms/room.schemas.ts`
- Create: `apps/server/src/rooms/room.service.ts`
- Create: `apps/server/src/rooms/room.routes.ts`
- Create: `apps/server/src/rooms/room.routes.test.ts`
- Modify: `apps/server/src/app.ts`
- Create: `packages/contracts/src/rooms.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Produces: `createOwnerToken(): string`, `hashOwnerToken(token, pepper): Promise<string>`, and `verifyOwnerToken(token, encodedHash, pepper): Promise<boolean>`.
- Produces: `signParticipant({ roomId, participantId }, secret): string` and `verifyParticipant(cookie, secret): ParticipantClaims`.
- Produces: `POST /api/rooms`, `POST /api/rooms/:roomId/join`, and `GET /api/rooms/:roomId`.
- Produces: `RoomMode = "shared" | "solo"`, `CreateRoomRequest`, `CreateRoomResponse`, `JoinRoomRequest`, `JoinRoomResponse`, and `RoomSummary` schemas from `@architect/contracts`.

- [ ] **Step 1: Write failing auth and route tests**

```ts
it("stores only a non-reversible owner token hash", async () => {
  const token = createOwnerToken();
  const encoded = await hashOwnerToken(token, "p".repeat(32));
  expect(encoded).not.toContain(token);
  await expect(verifyOwnerToken(token, encoded, "p".repeat(32))).resolves.toBe(true);
});

it("creates a room and sets owner and participant cookies", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/rooms",
    payload: { name: "Ada", color: "#10A37F", mode: "shared" },
  });
  expect(response.statusCode).toBe(201);
  expect(response.cookies.some((cookie) => cookie.name.startsWith("architect_owner_"))).toBe(true);
  expect(response.cookies.some((cookie) => cookie.name.startsWith("architect_participant_"))).toBe(true);
  expect(response.json()).toMatchObject({ phase: "sketch", isOwner: true });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test --workspace @architect/server -- auth.test.ts room.routes.test.ts`

Expected: FAIL because credential helpers and room routes are missing.

- [ ] **Step 3: Implement room-scoped credentials and services**

Use 32 random bytes for raw owner tokens, `scrypt` with a random 16-byte salt plus the server pepper, constant-time comparison, and signed participant cookies. Cookie names are `architect_owner_<roomId>` and `architect_participant_<roomId>` so one browser can participate in multiple rooms. Use these attributes:

```ts
const roomCookieOptions = (roomId: string) => ({
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: `/`,
  maxAge: 60 * 60 * 24 * 30,
});
```

Create validates the same profile fields as join, persists `shared` or `solo` mode, and returns the join path without an owner token. Join validates trimmed names from 1–60 characters and `#RRGGBB` colors, rejects joining a solo room from another participant, upserts a room participant, and issues only the participant cookie.

- [ ] **Step 4: Pass focused and persistence tests**

Run: `npm test --workspace @architect/server -- auth.test.ts room.routes.test.ts`

Expected: all auth and room tests pass, including unknown room 404, invalid profile 422, and join without owner elevation.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/auth apps/server/src/rooms apps/server/src/app.ts packages/contracts/src
git commit -m "feat: add secure guest rooms"
```

### Task 4: Build landing, onboarding, and the Guided Workspace shell

**Files:**
- Modify: `apps/web/src/app/page.tsx`
- Create: `apps/web/src/app/start/page.tsx`
- Create: `apps/web/src/app/room/[roomId]/page.tsx`
- Create: `apps/web/src/features/rooms/api.ts`
- Create: `apps/web/src/features/rooms/profile.ts`
- Create: `apps/web/src/features/rooms/StartRoom.tsx`
- Create: `apps/web/src/features/rooms/StartRoom.test.tsx`
- Create: `apps/web/src/features/workspace/WorkspaceShell.tsx`
- Create: `apps/web/src/features/workspace/PhaseRail.tsx`
- Create: `apps/web/src/features/workspace/WorkspaceShell.test.tsx`
- Create: `packages/ui/src/Button.tsx`
- Create: `packages/ui/src/Field.tsx`
- Create: `packages/ui/src/StatusBadge.tsx`
- Create: `packages/ui/src/tokens.css`
- Modify: `packages/ui/src/index.ts`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: room endpoints and schemas from Task 3.
- Produces: `roomApi.create(profile, mode)`, `roomApi.join(roomId, profile)`, and `roomApi.get(roomId)`.
- Produces: `WorkspaceShellProps { room: RoomSummary; children: ReactNode; contextPanel?: ReactNode }`.
- Produces: responsive phase rail with `sketch`, `architect`, and `deploy` states.

- [ ] **Step 1: Write failing onboarding and shell tests**

```tsx
it("creates a room only after a valid guest profile is entered", async () => {
  render(<StartRoom api={fakeRoomApi} />);
  expect(screen.getByRole("button", { name: /create room/i })).toBeDisabled();
  await userEvent.type(screen.getByLabelText(/display name/i), "Ada");
  await userEvent.click(screen.getByRole("button", { name: /create room/i }));
  expect(fakeRoomApi.create).toHaveBeenCalledWith(
    { name: "Ada", color: "#10A37F" },
    "shared",
  );
});

it("marks the current workspace phase with text and aria-current", () => {
  render(<PhaseRail phase="architect" />);
  expect(screen.getByText("Architect").closest("a")).toHaveAttribute("aria-current", "step");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test --workspace @architect/web -- StartRoom.test.tsx WorkspaceShell.test.tsx`

Expected: FAIL because onboarding and shell components do not exist.

- [ ] **Step 3: Implement the approved visual shell and room bootstrapping**

Use CSS custom properties rather than scattered color literals:

```css
:root {
  --surface: #f7f7f4;
  --panel: #ffffff;
  --rail: #efefec;
  --ink: #222220;
  --muted: #6f6f69;
  --border: #d9d9d3;
  --success: #19875a;
  --success-soft: #e8f3ed;
  --warning: #9a681f;
  --warning-soft: #fff1d9;
  --danger: #b44b40;
  --focus: #2563eb;
  --radius-panel: 18px;
}
```

The room page fetches `RoomSummary`, renders loading/not-found states, and places an empty content surface inside `WorkspaceShell`. The onboarding page exposes Create shared room, Join room, and Work alone; Work alone creates a durable `solo` room that uses the same server and collaboration contracts but rejects additional participants. Preserve the display profile locally only for convenience; authority comes from the signed cookie.

- [ ] **Step 4: Pass UI tests and production build**

Run: `npm test --workspace @architect/web -- StartRoom.test.tsx WorkspaceShell.test.tsx`

Run: `npm run build --workspace @architect/web`

Expected: component tests and Next.js build pass without hydration warnings.

- [ ] **Step 5: Demonstrate persistent rooms**

Create a room through the browser, join its shared URL in a private window, restart server and web, and reload both clients.

Expected: both clients return to the same `sketch` room; the private client is not an owner.

- [ ] **Step 6: Commit**

```bash
git add apps/web packages/ui
git commit -m "feat: add guided guest workspace"
```

**Milestone 1 checkpoint:** Create, join, reload, and recover a room through the Guided Workspace shell. Run server room integration tests, web component tests, typecheck, and production build; then push verified commits.

---

## Milestone 2 — Multiplayer Sketching, Presence, Requirements, and Consensus

### Task 5: Persist Yjs documents and run Hocuspocus collaboration

**Files:**
- Create: `apps/server/src/collab/yjs.repository.ts`
- Create: `apps/server/src/collab/yjs.repository.test.ts`
- Create: `apps/server/src/collab/snapshot.service.ts`
- Create: `apps/server/src/collab/hocuspocus.ts`
- Create: `apps/server/src/collab/awareness.registry.ts`
- Create: `apps/server/src/collab/hocuspocus.test.ts`
- Modify: `apps/server/src/index.ts`
- Create: `apps/web/src/features/workspace/collab.ts`
- Create: `apps/web/src/features/workspace/usePresence.ts`
- Create: `packages/contracts/src/collaboration.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Produces: `loadRoomDocument(roomId): Promise<Y.Doc>` and `persistRoomSnapshot(roomId, doc, reason): Promise<number>`.
- Produces: `createHocuspocusServer({ prisma, env, awarenessRegistry })`.
- Produces: `createRoomCollab({ roomId }): { doc, provider, destroy }`.
- Produces: awareness profile `{ participantId, name, color, cursor?, phase, lastSeenAt }`.

- [ ] **Step 1: Write failing snapshot recovery tests**

```ts
it("restores the latest Yjs snapshot after a new process loads the room", async () => {
  const first = new Y.Doc();
  first.getMap("meta").set("phase", "sketch");
  await repository.persistRoomSnapshot(room.id, first, "test");
  const restored = await repository.loadRoomDocument(room.id);
  expect(restored.getMap("meta").get("phase")).toBe("sketch");
});
```

- [ ] **Step 2: Run focused tests to verify failure**

Run: `npm test --workspace @architect/server -- yjs.repository.test.ts hocuspocus.test.ts`

Expected: FAIL because the collaboration repository and server do not exist.

- [ ] **Step 3: Implement snapshot loading, debounced persistence, and authenticated connections**

Encode snapshots with `Y.encodeStateAsUpdate`, store bytes in `YjsSnapshot.payload`, and load only the latest version. On WebSocket connection, verify the signed participant cookie belongs to the document room. Update the in-memory awareness registry on connect, awareness change, heartbeat, and disconnect. Persist snapshots after a bounded debounce, phase transitions, and shutdown.

```ts
export async function loadRoomDocument(roomId: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const latest = await prisma.yjsSnapshot.findFirst({
    where: { roomId },
    orderBy: { version: "desc" },
  });
  if (latest) Y.applyUpdate(doc, new Uint8Array(latest.payload));
  return doc;
}

export async function persistRoomSnapshot(
  roomId: string,
  doc: Y.Doc,
  reason: string,
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const latest = await tx.yjsSnapshot.aggregate({ where: { roomId }, _max: { version: true } });
    const version = (latest._max.version ?? 0) + 1;
    await tx.yjsSnapshot.create({
      data: { roomId, version, reason, payload: Buffer.from(Y.encodeStateAsUpdate(doc)) },
    });
    return version;
  });
}
```

- [ ] **Step 4: Pass recovery and authorization tests**

Run: `npm test --workspace @architect/server -- yjs.repository.test.ts hocuspocus.test.ts`

Expected: snapshot restore, cross-room denial, reconnect, and graceful-shutdown persistence tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/collab apps/server/src/index.ts apps/web/src/features/workspace packages/contracts/src
git commit -m "feat: persist collaborative room documents"
```

### Task 6: Add tldraw, remote presence, and workload requirements

**Files:**
- Create: `packages/contracts/src/requirements.ts`
- Create: `packages/contracts/src/requirements.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/web/src/features/sketch/Whiteboard.tsx`
- Create: `apps/web/src/features/sketch/tldrawBinding.ts`
- Create: `apps/web/src/features/sketch/tldrawBinding.test.ts`
- Create: `apps/web/src/features/sketch/RequirementsPanel.tsx`
- Create: `apps/web/src/features/sketch/RequirementsPanel.test.tsx`
- Create: `apps/web/src/features/workspace/MemberStrip.tsx`
- Create: `apps/web/src/features/workspace/CursorOverlay.tsx`
- Modify: `apps/web/src/app/room/[roomId]/page.tsx`

**Interfaces:**
- Produces: `RequirementsProfile` schema with audience, criticality, expected users, traffic, burstiness, async work, availability, and recovery.
- Produces: Yjs keys `tldraw/records`, `requirements/current`, and awareness profiles from Task 5.
- Produces: `captureWhiteboard(editor): Promise<{ imageDataUrl: string; mimeType: "image/png"; hasShapes: boolean }>`.

- [ ] **Step 1: Write failing requirements and synchronization tests**

```ts
it("creates the safe default requirements profile", () => {
  expect(defaultRequirementsProfile()).toEqual({
    version: "requirements/v1",
    audience: "external",
    criticality: "non_critical",
    expectedUsers: "tiny",
    traffic: "low",
    burstiness: "steady",
    asyncWorkload: false,
    availability: "best_effort",
    recovery: "flexible",
  });
});

it("copies document records between tldraw and Yjs without camera state", () => {
  binding.write({ id: "shape:1", typeName: "shape" });
  binding.write({ id: "camera:page:1", typeName: "camera" });
  expect([...records.keys()]).toEqual(["shape:1"]);
});
```

- [ ] **Step 2: Run focused tests to verify failure**

Run: `npm test --workspace @architect/contracts -- requirements.test.ts`

Run: `npm test --workspace @architect/web -- tldrawBinding.test.ts RequirementsPanel.test.tsx`

Expected: FAIL because requirements and sketch components do not exist.

- [ ] **Step 3: Implement collaborative sketching and requirements**

Bind only tldraw document records; exclude pointer, camera, instance, and page-state records. Publish participant presence at a bounded interval and on meaningful changes. Store the validated requirements object as one Yjs map value so concurrent field changes remain explicit and schema-checked before reconstruction.

```ts
export function shouldSyncTldrawRecord(id: string): boolean {
  return !["pointer:", "camera:", "instance:", "instance_page_state:"].some((prefix) =>
    id.startsWith(prefix),
  );
}

export function writeRequirements(doc: Y.Doc, input: RequirementsProfile): void {
  const requirements = requirementsProfileSchema.parse(input);
  doc.getMap<RequirementsProfile>("requirements").set("current", requirements);
}
```

- [ ] **Step 4: Pass focused tests and a two-client browser check**

Run: `npm test --workspace @architect/contracts -- requirements.test.ts`

Run: `npm test --workspace @architect/web -- tldrawBinding.test.ts RequirementsPanel.test.tsx`

Expected: focused tests pass. In two browser contexts, a shape and requirements change made by one participant appear in the other, while remote cursors show distinct names and colors.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts apps/web/src/features/sketch apps/web/src/features/workspace apps/web/src/app/room
git commit -m "feat: add collaborative architecture sketching"
```

### Task 7: Implement signed voting and idempotent transition claims

**Files:**
- Create: `packages/contracts/src/voting.ts`
- Create: `packages/contracts/src/voting.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/server/src/rooms/vote.service.ts`
- Create: `apps/server/src/rooms/vote.service.test.ts`
- Create: `apps/server/src/rooms/vote.routes.ts`
- Modify: `apps/server/src/app.ts`
- Create: `apps/web/src/features/sketch/ReadinessVote.tsx`
- Create: `apps/web/src/features/sketch/ReadinessVote.test.tsx`

**Interfaces:**
- Produces: `VoteKind = "ready" | "deploy_localstack" | "deploy_aws"`.
- Produces: `evaluateVote({ activeParticipantIds, voterIds, threshold }): VoteSnapshot`.
- Produces: `POST /api/rooms/:roomId/votes/:kind` and `DELETE /api/rooms/:roomId/votes/:kind` bound to signed participant identity.
- Produces: `claimTransition(roomId, expectedRevision, kind): Promise<{ claimed: boolean; jobId: string }>` using a database uniqueness constraint.

- [ ] **Step 1: Write failing threshold and duplicate-claim tests**

```ts
it("requires four of five active participants at the 80 percent threshold", () => {
  expect(evaluateVote({
    activeParticipantIds: ["a", "b", "c", "d", "e"],
    voterIds: ["a", "b", "c", "d"],
    threshold: 0.8,
  })).toMatchObject({ tally: 4, total: 5, met: true });
});

it("returns the same transition job for concurrent claims", async () => {
  const [first, second] = await Promise.all([
    service.claimTransition(room.id, 0, "ready"),
    service.claimTransition(room.id, 0, "ready"),
  ]);
  expect(new Set([first.jobId, second.jobId]).size).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test --workspace @architect/contracts -- voting.test.ts`

Run: `npm test --workspace @architect/server -- vote.service.test.ts`

Expected: FAIL because voting contracts and services do not exist.

- [ ] **Step 3: Implement server-authoritative votes and transition claims**

Count only signed participants present in the awareness registry, always include the current requester during a heartbeat race, and clear expired votes when membership changes. Store votes in Yjs for shared display but accept mutations only through the signed HTTP route. Use one database job row keyed by room, revision, and transition kind to make claims idempotent.

```ts
export function evaluateVote(input: VoteInput): VoteSnapshot {
  const active = new Set(input.activeParticipantIds);
  const tally = [...new Set(input.voterIds)].filter((id) => active.has(id)).length;
  const total = active.size;
  const ratio = total === 0 ? 0 : tally / total;
  return { tally, total, ratio, met: tally > 0 && ratio >= input.threshold };
}

export async function claimTransition(
  roomId: string,
  sourceRevision: number,
  kind: "ready",
): Promise<TransitionJob> {
  return prisma.transitionJob.upsert({
    where: { roomId_sourceRevision_kind: { roomId, sourceRevision, kind } },
    create: { roomId, sourceRevision, kind, traceId: crypto.randomUUID() },
    update: {},
  });
}
```

- [ ] **Step 4: Pass tests and demonstrate consensus**

Run: `npm test --workspace @architect/contracts -- voting.test.ts`

Run: `npm test --workspace @architect/server -- vote.service.test.ts`

Run: `npm test --workspace @architect/web -- ReadinessVote.test.tsx`

Expected: threshold, participant impersonation, disconnect recalculation, solo-room, and duplicate-claim tests pass. Two browser clients show synchronized vote progress and one transition claim.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts apps/server/src/rooms apps/server/src/app.ts apps/web/src/features/sketch
git commit -m "feat: add consensus-gated phase transitions"
```

**Milestone 2 checkpoint:** In two isolated browser contexts, draw together, edit requirements, see presence, vote, and observe exactly one readiness transition claim. Restart the server and confirm the sketch and requirements recover; then push verified commits.

---

## Milestone 3 — Validated AI Reconstruction and Typed Infrastructure

### Task 8: Define the infrastructure catalog, intent, staging, and graph compiler

**Files:**
- Create: `packages/contracts/src/infrastructure.ts`
- Create: `packages/contracts/src/infrastructure.test.ts`
- Create: `packages/contracts/src/architecture.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/infra/src/catalog.ts`
- Create: `packages/infra/src/catalog.test.ts`
- Create: `packages/infra/src/staging.ts`
- Create: `packages/infra/src/staging.test.ts`
- Create: `packages/infra/src/compiler.ts`
- Create: `packages/infra/src/compiler.test.ts`
- Modify: `packages/infra/src/index.ts`

**Interfaces:**
- Produces: `InfrastructureIntent`, `Architecture`, `ArchitectureResource`, `ArchitectureRelationship`, `StageDecision`, `DeploymentPlan`, `Diagnostic`, and `ResourceOrigin` Zod schemas.
- Produces: `RESOURCE_CATALOG: Record<AwsResourceType, ResourceCapability>` with diagram, synth, LocalStack, and AWS support flags.
- Produces: `selectStage(requirements): StageDecision`.
- Produces: `buildDeploymentPlan(intent, requirements): DeploymentPlan`.
- Produces: `compileIntent(intent, requirements): { architecture, stageDecision, deploymentPlan, diagnostics }`.

- [ ] **Step 1: Write failing staging and provenance tests**

```ts
it("selects growth and proposes redundant ingress for a bursty critical workload", () => {
  const result = selectStage({
    ...defaultRequirementsProfile(),
    criticality: "business_critical",
    traffic: "high",
    burstiness: "bursty",
    availability: "high",
  });
  expect(result.stage).toBe("growth");
  expect(result.requiresApproval).toBe(true);
});

it("keeps explicit and inferred resources distinguishable", () => {
  const result = compileIntent(ec2Intent, externalCriticalRequirements);
  expect(result.architecture.resources.find((item) => item.id === "app")?.origin).toBe("explicit");
  expect(result.architecture.resources.some((item) => item.origin === "inferred-minimal")).toBe(true);
  expect(result.architecture.resources.some((item) => item.origin === "stage-upgrade")).toBe(true);
});
```

- [ ] **Step 2: Run package tests to verify failure**

Run: `npm test --workspace @architect/contracts -- infrastructure.test.ts`

Run: `npm test --workspace @architect/infra -- catalog.test.ts staging.test.ts compiler.test.ts`

Expected: FAIL because contracts and compiler functions are missing.

- [ ] **Step 3: Implement strict contracts and deterministic compilation**

Use a discriminated resource schema and separate semantic/view models:

```ts
export const resourceOriginSchema = z.enum(["explicit", "inferred-minimal", "stage-upgrade"]);

export const architectureResourceSchema = z.object({
  id: z.string().min(1),
  type: awsResourceTypeSchema,
  name: z.string().min(1).max(120),
  properties: z.record(z.union([z.string(), z.number(), z.boolean()])),
  origin: resourceOriginSchema,
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  approvalStatus: z.enum(["not-required", "pending", "approved", "rejected"]),
});
```

Port the reference resource catalog and staging concepts, but make output deterministic: stable IDs, stable sorting, explicit diagnostic codes, and no random layout or resource IDs. Every unsupported synth resource produces an error diagnostic before deployment.

- [ ] **Step 4: Pass compiler tests and snapshot representative outputs**

Run: `npm test --workspace @architect/contracts -- infrastructure.test.ts`

Run: `npm test --workspace @architect/infra -- catalog.test.ts staging.test.ts compiler.test.ts`

Expected: prototype, MVP, growth, production, explicit origin, inferred prerequisites, approval-gated upgrades, dangling links, duplicate IDs, and deterministic-order tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts packages/infra
git commit -m "feat: compile infrastructure intent into typed architecture"
```

### Task 9: Build OpenAI-first and Anthropic-fallback AI adapters

**Files:**
- Create: `apps/server/src/ai/provider.ts`
- Create: `apps/server/src/ai/openai.provider.ts`
- Create: `apps/server/src/ai/openai.provider.test.ts`
- Create: `apps/server/src/ai/anthropic.provider.ts`
- Create: `apps/server/src/ai/anthropic.provider.test.ts`
- Create: `apps/server/src/ai/failover.ts`
- Create: `apps/server/src/ai/failover.test.ts`
- Create: `apps/server/src/ai/prompts/reconstruct.ts`
- Create: `apps/server/src/ai/prompts/architect.ts`

**Interfaces:**
- Consumes: `InfrastructureIntent` and graph-operation contracts.
- Produces: `AiProvider` with `reconstruct(input: ReconstructionInput): Promise<InfrastructureIntent>` and `architect(input: ArchitectTurnInput): Promise<ArchitectTurn>`.
- Produces: `createFailoverProvider(primary, fallback, policy): AiProvider`.
- Produces: stable errors `AiTimeoutError`, `AiRefusalError`, `AiProviderError`, and `AiOutputError` with `fallbackEligible` metadata.

- [ ] **Step 1: Write failing structured-output and failover tests**

```ts
it("sends the board as image input and parses strict InfraIntent", async () => {
  openai.responses.parse = vi.fn().mockResolvedValue({
    output_parsed: validIntent,
    output: [],
  });
  await expect(provider.reconstruct(reconstructionInput)).resolves.toEqual(validIntent);
  expect(openai.responses.parse).toHaveBeenCalledWith(expect.objectContaining({
    model: "gpt-5.6",
    input: expect.any(Array),
    text: expect.objectContaining({ format: expect.any(Object) }),
  }));
});

it("uses Anthropic only for eligible OpenAI failures", async () => {
  primary.reconstruct.mockRejectedValue(new AiTimeoutError("trace-1"));
  fallback.reconstruct.mockResolvedValue(validIntent);
  await expect(ai.reconstruct(reconstructionInput)).resolves.toEqual(validIntent);
  expect(fallback.reconstruct).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run adapter tests to verify failure**

Run: `npm test --workspace @architect/server -- openai.provider.test.ts anthropic.provider.test.ts failover.test.ts`

Expected: FAIL because provider adapters and failover policy do not exist.

- [ ] **Step 3: Implement strict OpenAI Responses calls and bounded fallback**

Use the OpenAI JavaScript SDK's Responses parsing helper with the shared Zod schema. Image content uses a `data:image/png;base64,...` URL. Set explicit provider timeouts and send a privacy-preserving participant identifier where supported. Architect tools use strict JSON schemas with `additionalProperties: false`.

```ts
export async function reconstructWithOpenAI(input: ReconstructionInput): Promise<InfrastructureIntent> {
  const response = await client.responses.parse({
    model: env.OPENAI_VISION_MODEL,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: RECONSTRUCTION_PROMPT },
        { type: "input_image", image_url: input.imageDataUrl, detail: "high" },
      ],
    }],
    text: { format: zodTextFormat(infrastructureIntentSchema, "infrastructure_intent") },
    safety_identifier: input.safetyIdentifier,
  });
  if (!response.output_parsed) {
    throw new AiOutputError(input.traceId, "OpenAI returned no parsed infrastructure intent.");
  }
  return infrastructureIntentSchema.parse(response.output_parsed);
}
```

The failover provider must use Anthropic only for timeout, transient provider, refusal, or exhausted model-output repair. Configuration errors, invalid application input, and compiler errors return directly. Record the selected provider and model in `AiRun` without prompts, images, cookies, or keys.

```ts
export function createFailoverProvider(
  primary: AiProvider,
  fallback: AiProvider | null,
): AiProvider {
  const run = async <T>(operation: (provider: AiProvider) => Promise<T>): Promise<T> => {
    try {
      return await operation(primary);
    } catch (error) {
      if (!fallback || !(error instanceof AiError) || !error.fallbackEligible) throw error;
      return operation(fallback);
    }
  };
  return {
    reconstruct: (input) => run((provider) => provider.reconstruct(input)),
    architect: (input) => run((provider) => provider.architect(input)),
  };
}
```

- [ ] **Step 4: Pass provider contract tests**

Run: `npm test --workspace @architect/server -- openai.provider.test.ts anthropic.provider.test.ts failover.test.ts`

Expected: strict parse, refusal, timeout, transient error, invalid schema, no-fallback validation error, Anthropic success, and redacted logging tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/ai
git commit -m "feat: add OpenAI AI pipeline with Anthropic fallback"
```

### Task 10: Run idempotent reconstruction jobs and expose the diagnostic bench

**Files:**
- Create: `packages/contracts/src/reconstruction.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/server/src/reconstruction/reconstruction.service.ts`
- Create: `apps/server/src/reconstruction/reconstruction.service.test.ts`
- Create: `apps/server/src/reconstruction/reconstruction.routes.ts`
- Create: `apps/server/src/reconstruction/reconstruction.routes.test.ts`
- Modify: `apps/server/src/app.ts`
- Create: `apps/web/src/features/sketch/useReconstruction.ts`
- Modify: `apps/web/src/features/sketch/ReadinessVote.tsx`
- Create: `apps/web/src/features/debug/DebugBench.tsx`
- Create: `apps/web/src/app/debug/page.tsx`
- Create: `apps/web/src/features/debug/DebugBench.test.tsx`

**Interfaces:**
- Consumes: transition claim from Task 7, AI provider from Task 9, and compiler from Task 8.
- Produces: `POST /api/rooms/:roomId/reconstruction` with `{ imageDataUrl, mimeType, requirements, sourceSnapshotVersion }`.
- Produces: `GET /api/rooms/:roomId/reconstruction/:jobId`.
- Produces: successful result `{ traceId, provider, intent, diagnostics, stageDecision, deploymentPlan, architectureRevisionId }`.
- Produces: debug-only parse API that uses the same service without mutating a room.

- [ ] **Step 1: Write failing job and phase-transition tests**

```ts
it("creates one revision and advances the room after valid reconstruction", async () => {
  const result = await service.reconstruct(validJobInput);
  expect(result.architectureRevisionId).toBeTruthy();
  expect(await prisma.architectureRevision.count({ where: { roomId } })).toBe(1);
  expect((await prisma.room.findUniqueOrThrow({ where: { id: roomId } })).phase).toBe("architect");
});

it("keeps the room in sketch after provider failure", async () => {
  ai.reconstruct.mockRejectedValue(new AiProviderError("unavailable", true));
  await expect(service.reconstruct(validJobInput)).rejects.toMatchObject({ code: "AI_UNAVAILABLE" });
  expect((await prisma.room.findUniqueOrThrow({ where: { id: roomId } })).phase).toBe("sketch");
});
```

- [ ] **Step 2: Run reconstruction tests to verify failure**

Run: `npm test --workspace @architect/server -- reconstruction.service.test.ts reconstruction.routes.test.ts`

Run: `npm test --workspace @architect/web -- DebugBench.test.tsx`

Expected: FAIL because reconstruction services, routes, and bench do not exist.

- [ ] **Step 3: Implement transactional reconstruction and shared diagnostics**

Validate image size and MIME type, verify the readiness threshold and signed participant, claim the job by source snapshot version, create `AiRun`, call the provider, compile intent, create an immutable revision, append history, update Yjs architecture state, and finally update the room phase. On error, persist redacted job diagnostics, clear readiness votes, keep the sketch intact, and keep the room in `sketch`.

The debug bench displays requirements, intent, diagnostics, stage decision, deployment plan, semantic graph JSON, and provider metadata. It never displays or accepts raw API keys.

```ts
export async function reconstructRoom(input: ReconstructionJobInput): Promise<ReconstructionResult> {
  return withClaimedTransition(input.transitionJobId, async (job) => {
    await setRoomPhase(job.roomId, "reconstructing");
    try {
      const intent = await ai.reconstruct(input.aiInput);
      const compiled = compileIntent(intent, input.requirements);
      if (compiled.diagnostics.some((item) => item.level === "error")) {
        throw new PublicError("RECONSTRUCTION_INVALID", "The sketch needs clarification.");
      }
      const revision = await revisionService.createFromReconstruction(job.roomId, compiled);
      await setRoomPhase(job.roomId, "architect");
      return { ...compiled, architectureRevisionId: revision.id, traceId: job.traceId };
    } catch (error) {
      await setRoomPhase(job.roomId, "sketch");
      await voteService.clear(job.roomId, "ready");
      throw error;
    }
  });
}
```

- [ ] **Step 4: Pass tests and demonstrate sketch-to-graph**

Run: `npm test --workspace @architect/server -- reconstruction.service.test.ts reconstruction.routes.test.ts`

Run: `npm test --workspace @architect/web -- DebugBench.test.tsx`

Expected: success, duplicate submission, oversized image, unsupported MIME, provider failure, compiler failure, restart recovery, and debug non-mutation tests pass. With `OPENAI_API_KEY` set locally, a simple supplier-portal sketch advances to Architect and shows provenance.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts apps/server/src/reconstruction apps/server/src/app.ts apps/web/src/features apps/web/src/app/debug
git commit -m "feat: reconstruct sketches into architecture revisions"
```

**Milestone 3 checkpoint:** Use the diagnostic bench and a real room to convert a known sketch into validated intent and a deterministic typed revision. Demonstrate failure recovery with a mocked provider outage. Run compiler, provider, reconstruction, web, typecheck, and build gates; then push.

---

## Milestone 4 — Typed Architecture Editing, History, and AI Architect

### Task 11: Add semantic graph operations, revisions, history, and React Flow editing

**Files:**
- Create: `packages/contracts/src/operations.ts`
- Create: `packages/contracts/src/history.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/infra/src/operations.ts`
- Create: `packages/infra/src/operations.test.ts`
- Create: `apps/server/src/architecture/revision.service.ts`
- Create: `apps/server/src/architecture/revision.service.test.ts`
- Create: `apps/server/src/architecture/architecture.routes.ts`
- Modify: `apps/server/src/app.ts`
- Create: `apps/web/src/features/architecture/GraphEditor.tsx`
- Create: `apps/web/src/features/architecture/graphAdapter.ts`
- Create: `apps/web/src/features/architecture/graphAdapter.test.ts`
- Create: `apps/web/src/features/architecture/ResourcePalette.tsx`
- Create: `apps/web/src/features/architecture/ProvenanceBadge.tsx`
- Create: `apps/web/src/features/architecture/UpgradeReviewPanel.tsx`
- Create: `apps/web/src/features/architecture/UpgradeReviewPanel.test.tsx`
- Create: `apps/web/src/features/architecture/RevisionHistory.tsx`

**Interfaces:**
- Produces: discriminated `GraphOperation` union: `add_resource`, `update_resource`, `remove_resource`, `add_relationship`, `remove_relationship`, and `set_resource_approval`.
- Produces: `applyOperations(architecture, operations): OperationResult` with diagnostics and no partial mutation.
- Produces: `saveRevision({ roomId, baseRevisionId, architecture, layout, actor, rationale }): ArchitectureRevision`.
- Produces: `POST /api/rooms/:roomId/operations`, `POST /api/rooms/:roomId/revisions`, and `GET /api/rooms/:roomId/revisions`.

- [ ] **Step 1: Write failing atomic-operation and layout-separation tests**

```ts
it("rejects an operation batch atomically when one relationship dangles", () => {
  const result = applyOperations(baseArchitecture, [validAddResource, danglingRelationship]);
  expect(result.ok).toBe(false);
  expect(result.architecture).toEqual(baseArchitecture);
});

it("moves React Flow nodes without changing semantic resources", () => {
  const next = applyLayoutChange(viewLayout, { id: "app", position: { x: 40, y: 80 } });
  expect(next.nodes.app.position).toEqual({ x: 40, y: 80 });
  expect(baseArchitecture.resources).toEqual(originalResources);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test --workspace @architect/infra -- operations.test.ts`

Run: `npm test --workspace @architect/server -- revision.service.test.ts`

Run: `npm test --workspace @architect/web -- graphAdapter.test.ts`

Expected: FAIL because operations, revisions, and graph adapter do not exist.

- [ ] **Step 3: Implement typed manual editing and immutable revisions**

Validate operations against the catalog, reject duplicate IDs and dangling relationships, require confirmation metadata for destructive changes, and apply batches to a clone before committing. `set_resource_approval` can approve or reject only `stage-upgrade` resources; rejecting one also removes or rejects dependent stage-upgrade relationships atomically. Store working graph/layout in Yjs, but persist immutable revisions through the server. History events include actor type, signed participant ID, summary, rationale, and trace ID. `UpgradeReviewPanel` lists the reason, affected resources, and accept/reject actions for every pending upgrade.

```ts
export function applyOperations(
  architecture: Architecture,
  operations: GraphOperation[],
): OperationResult {
  const draft = structuredClone(architecture);
  for (const operation of operations) applyOneValidatedOperation(draft, operation);
  const parsed = architectureSchema.safeParse(draft);
  return parsed.success
    ? { ok: true, architecture: parsed.data, diagnostics: [] }
    : { ok: false, architecture, diagnostics: zodToDiagnostics(parsed.error) };
}
```

- [ ] **Step 4: Pass tests and demonstrate synchronized graph edits**

Run: `npm test --workspace @architect/infra -- operations.test.ts`

Run: `npm test --workspace @architect/server -- revision.service.test.ts`

Run: `npm test --workspace @architect/web -- graphAdapter.test.ts`

Expected: add/update/remove, upgrade approval/rejection, dependent relationship cleanup, dangling edge, conflict, destructive confirmation, revision versioning, provenance display, and layout separation tests pass. Two clients see graph edits and revision history update.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts packages/infra apps/server/src/architecture apps/server/src/app.ts apps/web/src/features/architecture
git commit -m "feat: add typed architecture editing and revisions"
```

### Task 12: Add AI architect chat and proposed-patch review

**Files:**
- Create: `packages/contracts/src/architect.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/server/src/architecture/architect.service.ts`
- Create: `apps/server/src/architecture/architect.service.test.ts`
- Create: `apps/server/src/architecture/architectProposal.repository.ts`
- Create: `apps/server/src/architecture/architect.routes.ts`
- Modify: `apps/server/src/app.ts`
- Create: `apps/web/src/features/architect/ArchitectPanel.tsx`
- Create: `apps/web/src/features/architect/PatchReviewDialog.tsx`
- Create: `apps/web/src/features/architect/ArchitectPanel.test.tsx`

**Interfaces:**
- Consumes: `AiProvider.architect`, graph operations, and revision service.
- Produces: `POST /api/rooms/:roomId/architect/turns` returning text plus a proposed operation batch.
- Produces: `POST /api/rooms/:roomId/architect/patches/:patchId/apply` requiring current revision and destructive confirmation when applicable.
- Produces: architect turn states `thinking`, `proposal_ready`, `applied`, `rejected`, and `failed`.

- [ ] **Step 1: Write failing proposal and stale-revision tests**

```ts
it("returns a proposal without mutating the current revision", async () => {
  const response = await service.runTurn(roomId, participant, "Make this highly available");
  expect(response.operations.length).toBeGreaterThan(0);
  expect(await currentRevisionId(roomId)).toBe(baseRevisionId);
});

it("rejects a patch created against a stale revision", async () => {
  await expect(service.applyPatch({ patchId, currentRevisionId: newerRevisionId }))
    .rejects.toMatchObject({ code: "REVISION_CONFLICT" });
});
```

- [ ] **Step 2: Run architect tests to verify failure**

Run: `npm test --workspace @architect/server -- architect.service.test.ts`

Run: `npm test --workspace @architect/web -- ArchitectPanel.test.tsx`

Expected: FAIL because architect services and components do not exist.

- [ ] **Step 3: Implement explain-or-propose behavior with strict tools**

Send the current semantic revision, requirements, relevant recent history, and user message to the AI provider. Expose only the graph tools needed for the turn. Parse every tool call into `GraphOperation`, validate it through `applyOperations`, and store the proposal without mutation. Apply only after user confirmation, then create a new revision and history entries. Never expose shell, CDK, database, or AWS tools.

```ts
export async function runArchitectTurn(input: ArchitectTurnRequest): Promise<ArchitectProposal> {
  const base = await revisionService.current(input.roomId);
  const turn = await ai.architect({
    message: input.message,
    architecture: base.architecture,
    requirements: base.requirements,
    history: await historyService.recent(input.roomId, 20),
  });
  const checked = applyOperations(base.architecture, turn.operations);
  if (!checked.ok) throw new PublicError("INVALID_AGENT_PATCH", "The proposed change was invalid.");
  return proposalRepository.create({ ...turn, roomId: input.roomId, baseRevisionId: base.id });
}
```

- [ ] **Step 4: Pass tests and demonstrate one deterministic patch**

Run: `npm test --workspace @architect/server -- architect.service.test.ts`

Run: `npm test --workspace @architect/web -- ArchitectPanel.test.tsx`

Expected: explanation-only, valid proposal, invalid tool arguments, stale revision, destructive confirmation, rejection, OpenAI-to-Anthropic failover, and applied revision tests pass. Demonstrate adding a validated SQS queue through patch review.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts apps/server/src/architecture apps/server/src/app.ts apps/web/src/features/architect
git commit -m "feat: add reviewable AI architect patches"
```

**Milestone 4 checkpoint:** Review a reconstructed graph in two clients, apply manual edits, save a revision, ask the architect for an explanation and one patch, review and apply it, and inspect immutable history. Run operation, revision, architect, web, typecheck, and build gates; then push.

---

## Milestone 5 — CDK Synthesis and LocalStack Deployment

### Task 13: Generate deployable CDK only for supported graph capabilities

**Files:**
- Create: `packages/infra/src/cdk/naming.ts`
- Create: `packages/infra/src/cdk/source.ts`
- Create: `packages/infra/src/cdk/wiring.ts`
- Create: `packages/infra/src/cdk/packageFiles.ts`
- Create: `packages/infra/src/cdk/source.test.ts`
- Create: `packages/infra/src/cdk/fixtures/supplier-portal.ts`
- Modify: `packages/infra/src/index.ts`

**Interfaces:**
- Produces: `compileArchitectureToCdk(architecture, stage): CdkBundle`.
- Produces: `CdkBundle { appTs, packageJson, tsconfigJson, cdkJson, diagnostics }`.
- Guarantees: blocking diagnostic `UNSUPPORTED_DEPLOY_RESOURCE` for any resource lacking synth support.

- [ ] **Step 1: Write failing CDK source and blocking-diagnostic tests**

```ts
it("generates deterministic CDK for the supplier portal fixture", () => {
  const bundle = compileArchitectureToCdk(supplierPortalArchitecture, "growth");
  expect(bundle.diagnostics.filter((item) => item.level === "error")).toEqual([]);
  expect(bundle.appTs).toMatchSnapshot();
});

it("blocks synthesis when an MSK resource is not implemented", () => {
  const bundle = compileArchitectureToCdk(mskArchitecture, "mvp");
  expect(bundle.diagnostics).toContainEqual(expect.objectContaining({
    code: "UNSUPPORTED_DEPLOY_RESOURCE",
    resourceId: "events",
  }));
});
```

- [ ] **Step 2: Run infrastructure tests to verify failure**

Run: `npm test --workspace @architect/infra -- source.test.ts`

Expected: FAIL because CDK compilation is missing.

- [ ] **Step 3: Implement deterministic CDK bundles and supported wiring**

Implement the supported v1 subset first: VPC/subnet intent through high-level VPC configuration, security groups, EC2, ELB, S3, Lambda, DynamoDB, SNS, SQS, API Gateway, and IAM roles. Implement Lambda grants to S3/DynamoDB/SNS, SNS subscriptions to SQS, and ELB targets to EC2. Use stable sanitized construct IDs, pinned CDK dependencies, bootstrapless synthesis for LocalStack, and no placeholder comments for unsupported resources.

```ts
export function compileArchitectureToCdk(
  architecture: Architecture,
  stage: WorkloadStage,
): CdkBundle {
  const unsupported = architecture.resources.filter(
    (resource) => !RESOURCE_CATALOG[resource.type].synthSupported,
  );
  if (unsupported.length > 0) {
    return {
      ...emptyCdkBundle(),
      diagnostics: unsupported.map((resource) => ({
        level: "error" as const,
        code: "UNSUPPORTED_DEPLOY_RESOURCE",
        message: `${resource.type} is diagram-only in v1.`,
        resourceId: resource.id,
      })),
    };
  }
  return renderCdkBundle({
    constructs: renderConstructs(architecture, stage),
    wiring: renderWiring(architecture),
  });
}
```

- [ ] **Step 4: Build generated fixtures and pass snapshots**

Run: `npm test --workspace @architect/infra -- source.test.ts`

Run a generated fixture: `npm run test:cdk-fixture --workspace @architect/infra`

Expected: snapshots pass, generated TypeScript compiles, and unsupported resource tests block before artifact execution.

- [ ] **Step 5: Commit**

```bash
git add packages/infra/src/cdk packages/infra/src/index.ts
git commit -m "feat: compile supported architectures to CDK"
```

### Task 14: Execute observable LocalStack deployment jobs

**Files:**
- Create: `packages/contracts/src/deployment.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/server/src/deploy/job.state.ts`
- Create: `apps/server/src/deploy/job.state.test.ts`
- Create: `apps/server/src/deploy/artifact.runner.ts`
- Create: `apps/server/src/deploy/artifact.runner.test.ts`
- Create: `apps/server/src/deploy/localstack.adapter.ts`
- Create: `apps/server/src/deploy/deploy.service.ts`
- Create: `apps/server/src/deploy/deploy.service.test.ts`
- Create: `apps/server/src/deploy/deploy.routes.ts`
- Create: `apps/server/src/deploy/debugDeploy.routes.ts`
- Create: `apps/server/src/deploy/debugDeploy.routes.test.ts`
- Modify: `apps/server/src/app.ts`
- Create: `apps/web/src/features/deploy/DeployWorkspace.tsx`
- Create: `apps/web/src/features/deploy/DeployVote.tsx`
- Create: `apps/web/src/features/deploy/DeployLogs.tsx`
- Create: `apps/web/src/features/deploy/DeployWorkspace.test.tsx`
- Modify: `apps/web/src/features/debug/DebugBench.tsx`
- Modify: `docker-compose.yml`

**Interfaces:**
- Produces: exact deploy states `queued`, `synthesizing`, `creating_change_set`, `awaiting_owner`, `executing`, `succeeded`, `failed`, and `cancelled`.
- Produces: `createDeployJob({ roomId, revisionId, target, actor }): DeployJob`.
- Produces: `POST /api/rooms/:roomId/deployments`, `GET /api/rooms/:roomId/deployments/:jobId`, and `GET /api/rooms/:roomId/deployments/:jobId/logs`.
- Produces: gated `POST /api/debug/deploy` for synth or LocalStack-only diagnostics when `ENABLE_DEBUG_ROUTES=true`; the route is absent otherwise and never accepts target `aws`.
- Produces: bounded stage runner using `spawn(command, args)` without shell interpolation.

- [ ] **Step 1: Write failing job-state and LocalStack tests**

```ts
it("prevents invalid job transitions", () => {
  expect(() => nextDeployState("succeeded", "executing")).toThrow("Invalid deployment transition");
});

it("deploys the immutable voted revision rather than the current working graph", async () => {
  const job = await service.createLocalStackJob({ roomId, votedRevisionId, participant });
  await service.run(job.id);
  expect(compiler.compileArchitectureToCdk).toHaveBeenCalledWith(votedRevision.architecture, votedRevision.stage);
});
```

- [ ] **Step 2: Run deployment tests to verify failure**

Run: `npm test --workspace @architect/server -- job.state.test.ts artifact.runner.test.ts deploy.service.test.ts debugDeploy.routes.test.ts`

Run: `npm test --workspace @architect/web -- DeployWorkspace.test.tsx`

Expected: FAIL because deployment jobs and UI do not exist.

- [ ] **Step 3: Implement isolated artifacts, bounded logs, and LocalStack execution**

Create a unique temporary directory from the job ID, write only files from `CdkBundle`, run pinned `npm install`, TypeScript build, `cdklocal synth`, bootstrap, and deploy using argument arrays, timeouts, and bounded output. Persist state and redacted logs before and after each stage. Require a valid LocalStack vote snapshot; consume the immutable voted revision. Pin the LocalStack Docker image in Compose. Reuse the artifact runner for the gated debug route, but restrict it to synth and LocalStack and apply its own strict rate limit.

```ts
export async function runLocalStackJob(jobId: string): Promise<void> {
  const job = await jobs.requireState(jobId, "queued");
  const revision = await revisions.get(job.revisionId);
  await jobs.transition(job.id, "synthesizing");
  const bundle = compileArchitectureToCdk(revision.architecture, revision.stage);
  assertNoBlockingDiagnostics(bundle.diagnostics);
  const artifacts = await artifactRunner.prepare(job.id, bundle);
  await artifactRunner.run(artifacts, "npm", ["install", "--no-audit", "--no-fund"]);
  await artifactRunner.run(artifacts, "npx", ["tsc"]);
  await artifactRunner.run(artifacts, "npx", ["cdklocal", "synth"]);
  await jobs.transition(job.id, "executing");
  await artifactRunner.run(artifacts, "npx", ["cdklocal", "deploy", "--require-approval", "never"]);
  await jobs.transition(job.id, "succeeded");
}
```

- [ ] **Step 4: Pass tests and deploy the supplier portal fixture**

Run: `docker compose up -d postgres localstack`

Run: `npm test --workspace @architect/server -- job.state.test.ts artifact.runner.test.ts deploy.service.test.ts debugDeploy.routes.test.ts`

Run: `npm run test:localstack --workspace @architect/server`

Expected: state, timeout, output truncation, unsupported resource, duplicate job, restart recovery, and successful fixture deployment tests pass. The UI shows live job state and redacted logs to both clients.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts apps/server/src/deploy apps/server/src/app.ts apps/web/src/features/deploy docker-compose.yml
git commit -m "feat: deploy approved revisions to LocalStack"
```

**Milestone 5 checkpoint:** Vote on a supported immutable revision, synthesize and deploy it to pinned LocalStack, inspect created resources, and show synchronized progress/logs. Run CDK fixture, deployment service, LocalStack integration, web, typecheck, and build gates; then push.

---

## Milestone 6 — Owner-Gated Real AWS Change Sets

### Task 15: Create, review, and execute CloudFormation change sets

**Files:**
- Create: `apps/server/src/deploy/aws.credentials.ts`
- Create: `apps/server/src/deploy/cloudformation.adapter.ts`
- Create: `apps/server/src/deploy/cloudformation.adapter.test.ts`
- Create: `apps/server/src/deploy/awsDeploy.service.ts`
- Create: `apps/server/src/deploy/awsDeploy.service.test.ts`
- Modify: `apps/server/src/deploy/deploy.routes.ts`
- Create: `apps/web/src/features/deploy/ChangeSetReview.tsx`
- Create: `apps/web/src/features/deploy/OwnerConfirmation.tsx`
- Create: `apps/web/src/features/deploy/ChangeSetReview.test.tsx`
- Modify: `.env.example`

**Interfaces:**
- Produces: `resolveAwsCredentials(env): Promise<AwsCredentialIdentity>` using default credentials and optional assume-role.
- Produces: `createChangeSet(job, template): Promise<ChangeSetSummary>`.
- Produces: `executeChangeSet(jobId, ownerToken): Promise<void>`.
- Produces: `POST /api/rooms/:roomId/deployments/:jobId/change-set`, `POST .../execute`, and `POST .../cancel`.
- Produces: normalized changes `{ action, logicalId, resourceType, replacement, details }`.

- [ ] **Step 1: Write failing authorization and change-set tests**

```ts
it("refuses AWS execution without both consensus and the room owner", async () => {
  await expect(service.execute(job.id, { participantCookie, ownerCookie: undefined }))
    .rejects.toMatchObject({ code: "OWNER_REQUIRED" });
});

it("creates a change set and waits instead of executing immediately", async () => {
  await service.prepare(job.id);
  expect(cloudFormation.createChangeSet).toHaveBeenCalledOnce();
  expect(cloudFormation.executeChangeSet).not.toHaveBeenCalled();
  expect(await jobState(job.id)).toBe("awaiting_owner");
});
```

- [ ] **Step 2: Run AWS tests to verify failure**

Run: `npm test --workspace @architect/server -- cloudformation.adapter.test.ts awsDeploy.service.test.ts`

Run: `npm test --workspace @architect/web -- ChangeSetReview.test.tsx`

Expected: FAIL because AWS adapters and review UI do not exist.

- [ ] **Step 3: Implement safe credential resolution and change-set lifecycle**

Use the AWS SDK default provider chain. If `AWS_DEPLOY_ROLE_ARN` is set, call STS AssumeRole with a job-specific session name. Verify the resolved region is in `AWS_ALLOWED_REGIONS` and stack name begins with `AWS_STACK_PREFIX`. Detect create versus update, create a named change set, wait for completion, normalize changes, and enter `awaiting_owner`. Execute only after re-verifying owner cookie, room, revision, consensus, job state, and change-set identity.

The UI must show account suffix, region, add/modify/delete action, replacement risk, team vote, synth status, and owner status. A deletion or replacement receives an explicit warning and confirmation phrase before execution.

```ts
export async function executeReviewedChangeSet(
  jobId: string,
  ownerToken: string,
): Promise<void> {
  const job = await jobs.requireState(jobId, "awaiting_owner");
  await ownerAuth.requireOwner(job.roomId, ownerToken);
  await votes.requireMet(job.roomId, "deploy_aws");
  await revisions.requireCurrentOrVoted(job.roomId, job.revisionId);
  await cloudFormation.requireSameChangeSet(job.stackName!, job.changeSetName!);
  await jobs.transition(job.id, "executing");
  try {
    await cloudFormation.executeChangeSet(job.stackName!, job.changeSetName!);
    await cloudFormation.waitForStack(job.stackName!);
    await jobs.transition(job.id, "succeeded");
  } catch (error) {
    await jobs.fail(job.id, publicAwsErrorCode(error));
    throw error;
  }
}
```

- [ ] **Step 4: Pass mocked AWS tests and run the opt-in sandbox check**

Run: `npm test --workspace @architect/server -- cloudformation.adapter.test.ts awsDeploy.service.test.ts`

Run: `npm test --workspace @architect/web -- ChangeSetReview.test.tsx`

Optional sandbox run: `RUN_AWS_SANDBOX_TESTS=1 npm run test:aws-sandbox --workspace @architect/server`

Expected: create, update, no-change, replacement warning, delete warning, region rejection, stack-prefix rejection, assume-role, wrong owner, stale revision, execute, cancel, and failure polling tests pass. The opt-in test creates and removes only a prefixed sandbox stack.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/deploy apps/web/src/features/deploy .env.example
git commit -m "feat: add owner-gated AWS change-set deployment"
```

**Milestone 6 checkpoint:** Against mocked AWS, demonstrate the entire change-set review and owner gate. If sandbox credentials are available, create, inspect, execute, and clean up one prefixed stack. Run all deploy tests and push only after confirming no credentials or account identifiers entered Git.

---

## Milestone 7 — Security, Accessibility, Observability, End-to-End Proof, and Release

### Task 16: Harden APIs, errors, tracing, redaction, and the responsive experience

**Files:**
- Create: `apps/server/src/observability/trace.ts`
- Modify: `apps/server/src/observability/errors.ts`
- Create: `apps/server/src/observability/redaction.ts`
- Create: `apps/server/src/observability/redaction.test.ts`
- Create: `apps/server/src/plugins/rateLimit.ts`
- Create: `apps/server/src/plugins/security.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/web/src/app/globals.css`
- Modify: `apps/web/src/features/workspace/WorkspaceShell.tsx`
- Create: `apps/web/src/features/workspace/MobileWorkspaceNav.tsx`
- Create: `apps/web/src/features/workspace/WorkspaceShell.a11y.test.tsx`
- Create: `packages/ui/src/Dialog.tsx`
- Create: `packages/ui/src/LiveStatus.tsx`
- Modify: `packages/ui/src/index.ts`

**Interfaces:**
- Produces: stable public error `{ code, message, traceId, details? }`.
- Produces: `redact(value): unknown` covering known key names, bearer tokens, cookies, AWS keys, and connection strings.
- Produces: route-class limits for general, AI, and deployment requests.
- Produces: desktop rail/context layout and mobile drawer/full-screen sheets with equivalent keyboard access.

- [ ] **Step 1: Write failing redaction, rate-limit, and accessibility tests**

```ts
it("redacts nested credentials and authorization headers", () => {
  expect(redact({ authorization: "Bearer secret", nested: { OPENAI_API_KEY: "sk-x" } }))
    .toEqual({ authorization: "[REDACTED]", nested: { OPENAI_API_KEY: "[REDACTED]" } });
});

it("moves focus into and back out of the mobile phase drawer", async () => {
  render(<WorkspaceShellForTest mobile />);
  await userEvent.click(screen.getByRole("button", { name: /open workspace navigation/i }));
  expect(screen.getByRole("dialog", { name: /workspace navigation/i })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("button", { name: /open workspace navigation/i })).toHaveFocus();
});
```

- [ ] **Step 2: Run hardening tests to verify failure**

Run: `npm test --workspace @architect/server -- redaction.test.ts`

Run: `npm test --workspace @architect/web -- WorkspaceShell.a11y.test.tsx`

Expected: FAIL because redaction and accessible mobile behavior are missing.

- [ ] **Step 3: Implement stable errors, rate limits, redaction, and responsive accessibility**

Attach a trace ID to each Fastify request and propagate it to AI runs, history events, and deploy jobs. Map internal errors to stable public codes. Configure payload limits, allowed origins, secure cookies, CSRF protection for mutating routes, session expiry, and stricter AI/deploy concurrency. Redact before logging and before database log persistence.

Complete the approved mobile behavior, visible focus, reduced-motion styles, semantic live regions, textual status labels, focus traps, and keyboard graph operations. Keep all core actions available without color or pointer input.

```ts
export function toPublicError(error: unknown, traceId: string): PublicErrorBody {
  if (error instanceof PublicError) {
    return { code: error.code, message: error.message, traceId, details: redact(error.details) };
  }
  return { code: "INTERNAL_ERROR", message: "The request could not be completed.", traceId };
}

export function registerTraceHook(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    request.traceId = request.headers["x-request-id"]?.toString() ?? crypto.randomUUID();
    reply.header("x-request-id", request.traceId);
  });
}
```

- [ ] **Step 4: Pass hardening and accessibility tests**

Run: `npm test --workspace @architect/server -- redaction.test.ts`

Run: `npm test --workspace @architect/web -- WorkspaceShell.a11y.test.tsx`

Run: `npm run typecheck && npm run build`

Expected: redaction, origin, CSRF, payload, concurrency, error-shape, focus, keyboard, live-region, contrast-token, and reduced-motion checks pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/observability apps/server/src/plugins apps/server/src/app.ts apps/web packages/ui
git commit -m "feat: harden and polish the guided workspace"
```

### Task 17: Prove the full workflow with Playwright, CI, documentation, and GitHub delivery

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/fixtures/ai.ts`
- Create: `tests/e2e/room-collaboration.spec.ts`
- Create: `tests/e2e/reconstruction-architect.spec.ts`
- Create: `tests/e2e/localstack-deploy.spec.ts`
- Create: `tests/e2e/accessibility.spec.ts`
- Create: `.github/workflows/ci.yml`
- Create: `apps/web/Dockerfile`
- Create: `apps/server/Dockerfile`
- Create: `nginx/default.conf`
- Create: `docs/assets/guided-workspace.png`
- Create: `README.md`
- Create: `docs/development.md`
- Create: `docs/deployment.md`
- Create: `docs/aws-sandbox.md`
- Create: `docs/demo-runbook.md`
- Modify: `.env.example`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: every earlier public interface.
- Produces: deterministic test provider selected only by `AI_PROVIDER=test` when `NODE_ENV=test`.
- Produces: documented commands for fresh install, development, testing, LocalStack, and opt-in AWS sandbox deployment.
- Produces: CI status suitable for protecting `main`.

- [ ] **Step 1: Write failing end-to-end tests with two browser contexts**

```ts
test("two guests sketch, agree, reconstruct, revise, and deploy", async ({ browser }) => {
  const owner = await browser.newContext();
  const guest = await browser.newContext();
  const ownerPage = await owner.newPage();
  const guestPage = await guest.newPage();

  const joinUrl = await createRoomAndReturnJoinUrl(ownerPage, { name: "Ada", color: "#10A37F" });
  await guestPage.goto(joinUrl);
  await joinRoom(guestPage, { name: "Linus", color: "#6B5CE7" });
  await drawSupplierPortal(ownerPage);
  await expectSharedSketch(guestPage);
  await voteReady(ownerPage, guestPage);
  await expect(ownerPage.getByText("Architecture review")).toBeVisible();
  await applyArchitectFixturePatch(ownerPage);
  await voteAndDeployLocalStack(ownerPage, guestPage);
  await expect(ownerPage.getByText("Deployment succeeded")).toBeVisible();
});
```

- [ ] **Step 2: Run Playwright to verify missing fixtures and selectors fail**

Run: `npm run test:e2e`

Expected: FAIL because the deterministic test provider, fixtures, and final selectors are not complete.

- [ ] **Step 3: Implement deterministic fixtures, complete documentation, and CI**

The test AI provider returns versioned fixtures through the same `AiProvider` interface and is impossible to enable outside test mode. CI starts PostgreSQL and LocalStack, applies migrations, installs Playwright browsers, runs lint/typecheck/unit/integration/build, then runs the four end-to-end specs.

The README leads with the product outcome, a Playwright-captured screenshot of the implemented Guided Workspace, architecture, quick start, environment configuration, and safe LocalStack default. Multi-stage Dockerfiles produce non-root production images. Nginx serves one public origin and proxies `/api` and collaboration WebSockets to the long-running server. Deployment documentation distinguishes application hosting from generated AWS infrastructure and states that real AWS requires a sandbox account, allowlisted region, stack prefix, and owner action.

```ts
export function selectAiProvider(env: ServerEnv): AiProvider {
  if (env.AI_PROVIDER === "test") {
    if (env.NODE_ENV !== "test") throw new Error("The test AI provider is restricted to NODE_ENV=test");
    return createFixtureAiProvider();
  }
  return createFailoverProvider(
    createOpenAiProvider(env),
    env.ANTHROPIC_API_KEY ? createAnthropicProvider(env) : null,
  );
}
```

```yaml
- run: npm ci
- run: npm run db:generate
- run: npm run db:migrate
- run: npm run lint
- run: npm run test
- run: npm run typecheck
- run: npm run build
- run: npx playwright install --with-deps chromium
- run: npm run test:e2e
```

- [ ] **Step 4: Run the complete release gate**

Run: `npm ci`

Run: `npm run db:generate && npm run db:migrate`

Run: `npm run lint && npm run test && npm run typecheck && npm run build`

Run: `npm run test:e2e`

Run: `docker compose build web server nginx`

Run: `git grep -nE '(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY)' -- ':!package-lock.json'`

Expected: install is reproducible; migrations, all tests, typecheck, application builds, production container builds, and Playwright pass; the secret scan returns no matches.

- [ ] **Step 5: Verify and push the GitHub release state**

```bash
git remote get-url origin
git push origin main
```

Expected: `origin` points to the authenticated user's private `TheArchitect` repository, `main` contains every verified source and documentation commit, and ignored `.env`, `.superpowers`, build, test-output, and CDK directories are absent.

- [ ] **Step 6: Commit the release proof**

```bash
git add playwright.config.ts tests .github apps/web/Dockerfile apps/server/Dockerfile nginx README.md docs .env.example docker-compose.yml
git commit -m "test: prove The Architect end to end"
git push origin main
```

**Milestone 7 checkpoint:** Run the release gate from a clean clone, record the two-browser and LocalStack demo, verify optional AWS sandbox instructions, confirm CI passes, and inspect GitHub for accidental secrets or generated artifacts.

---

## Milestone Verification Summary

| Milestone | Runnable outcome | Required gate |
|---|---|---|
| 0 | Web and server boot; PostgreSQL readiness survives migration | Unit, typecheck, build, health/readiness smoke |
| 1 | Create, join, reload, and recover secure guest rooms | Auth/room integration and web component tests |
| 2 | Two clients sketch, edit requirements, see presence, and reach one consensus claim | Collaboration recovery, voting, two-client smoke |
| 3 | Sketch becomes validated intent and a typed revision with provenance | Compiler, provider, reconstruction, debug bench |
| 4 | People and AI edit through typed, reviewable operations with immutable history | Operation, revision, architect, two-client graph smoke |
| 5 | Approved revision synthesizes and deploys to LocalStack | CDK fixture, deploy state machine, LocalStack integration |
| 6 | Reviewed change set executes only for the room owner | Mocked CloudFormation suite and optional sandbox run |
| 7 | Responsive, secure, accessible product passes full two-browser flow and CI | Complete release gate and secret scan |

## Assumptions and Deferred Decisions

- The authenticated GitHub account will own `TheArchitect`; the repository starts private and can be made public later without changing code.
- The application itself is delivered as Docker-compatible services behind a same-site reverse proxy. A specific hosting vendor is intentionally not selected because it does not change the implementation contracts.
- Real AWS validation uses a dedicated sandbox account controlled by the server operator. Production-account deployment is outside V1.
- The initial deployable catalog is the explicitly tested subset in Task 13. Diagram-only catalog entries remain usable in Architect mode but block synthesis with a diagnostic.
- Account login, organization workspaces, billing, multi-cloud, cost estimation, policy-as-code, GitHub export, and enterprise RBAC remain outside V1.
- Package installation resolves versions compatible with the declared major-version constraints and commits `package-lock.json`; upgrades after the initial lock require passing the complete relevant milestone gate.

## Decisions Requiring User Approval During Execution

- Any change from the modular monorepo or long-running Fastify/Hocuspocus server model.
- Any replacement of PostgreSQL/Prisma, Next.js 16, OpenAI primary, or Anthropic fallback.
- Any addition of a third AI provider or browser-side API credential.
- Any expansion of real AWS permissions, allowed regions, resource catalog, or deployment targets.
- Any public repository visibility change.
- Any decision to deploy the application to a specific paid hosting provider.

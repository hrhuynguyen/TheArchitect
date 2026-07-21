# The Architect — Product and Technical Design

**Date:** 2026-07-20
**Status:** Approved for implementation planning
**Repository:** `TheArchitect`
**Product inspiration:** VibeCloud / Architecture Studio reference implementation

## 1. Product definition

The Architect is a multiplayer, AI-assisted cloud architecture workspace that turns a rough team whiteboard into a typed, reviewable AWS architecture and then into deployable infrastructure.

The product begins before conventional infrastructure tools. Participants describe users, workflows, applications, data, constraints, and failure cases in business language. After the team reaches consensus, The Architect formalizes the sketch into a validated infrastructure model, explains what it inferred, lets people and an AI architect revise the model through typed operations, and deploys an approved revision through AWS CDK.

The defining workflow is:

```text
Sketch together
→ agree the sketch is ready
→ reconstruct and validate infrastructure intent
→ review a typed AWS graph
→ revise with people and an AI architect
→ synthesize and review a deployment
→ deploy to LocalStack or AWS
```

## 2. V1 scope

V1 includes:

- A restrained, OpenAI-inspired visual system implemented as an original Guided Workspace design
- Landing, onboarding, guest identity, room creation, room joining, and solo mode
- Shared tldraw whiteboards with participant presence and cursor identity
- A workload-requirements profile and an 80 percent readiness vote
- OpenAI-based vision reconstruction with schema validation and diagnostics
- Anthropic fallback for eligible OpenAI provider failures
- Deterministic requirements scoring, workload-stage selection, resource provenance, and graph compilation
- A typed React Flow AWS architecture editor
- A node library, manual graph editing, architecture revisions, and decision/change history
- An AI architect that explains the design and invokes allowlisted graph-editing tools
- An 80 percent deployment vote
- CDK synthesis and LocalStack deployment
- Real AWS deployment through a reviewed CloudFormation change set and room-owner confirmation
- PostgreSQL persistence for rooms, Yjs snapshots, revisions, history, AI runs, and deployment jobs
- Docker Compose development and production-oriented container configuration
- Unit, integration, LocalStack, end-to-end, and accessibility testing
- A standalone reconstruction/deployment diagnostic workbench

V1 does not include account-based authentication, organization workspaces, billing, multi-cloud deployment, a complete AWS service catalog, GitHub pull-request export, cost estimation, policy-as-code, or enterprise role-based access control. Its guest-room owner credential is intentionally narrower than a general account system.

## 3. Success criteria

The release is successful when two isolated browser clients can:

1. Create and join the same room.
2. See each other's presence and whiteboard changes.
3. Complete workload requirements and cross the readiness threshold.
4. Convert a representative sketch into validated infrastructure intent and a typed graph.
5. Distinguish explicit, minimally inferred, and approval-gated stage-upgrade resources.
6. Manually edit the graph and ask the AI architect to apply a validated graph patch.
7. Review immutable architecture revisions and history events.
8. Synthesize and deploy an approved graph to LocalStack.
9. Create, review, authorize, and execute a CloudFormation change set in a configured AWS sandbox account.
10. Recover the room, graph, and history after a server restart.

## 4. Architecture

The project uses an npm-workspace modular monorepo aligned with the reference repository while adopting the reference's current Next.js implementation rather than its stale Vite documentation.

```text
apps/
  web/          Next.js 16 App Router frontend
  server/       Fastify API, Hocuspocus, AI orchestration, deployment runner
packages/
  contracts/    Zod schemas, shared types, API DTOs, events
  infra/        Intent analysis, staging, graph compiler, CDK generator
  ui/           Design tokens and reusable Guided Workspace components
  config/       Shared TypeScript, lint, test, and environment configuration
```

### 4.1 Web application

`apps/web` owns presentation and direct user interaction:

- Next.js 16 App Router pages and layouts
- Landing and room onboarding
- Guided Workspace navigation and responsive shell
- tldraw whiteboard integration
- React Flow graph integration
- Requirements, provenance, revisions, history, chat, voting, and deployment review interfaces
- Client-side Yjs document binding and Hocuspocus provider

The web application does not receive or store AI keys, AWS credentials, owner-token hashes, or executable deployment commands.

### 4.2 Application server

`apps/server` initially runs Fastify and Hocuspocus in one process. It owns:

- Room and participant issuance
- Room-owner credential verification
- HTTP APIs and WebSocket collaboration
- Yjs snapshot loading and persistence
- Authoritative phase transitions and job idempotency
- AI provider adapters and orchestration
- Typed graph-operation validation and application
- Architecture revisions and audit history
- CDK synthesis and deployment jobs
- LocalStack and CloudFormation integration
- Structured logging, health, readiness, and trace identifiers

Deployment execution has a clean worker interface so it can move to a separate process without changing public contracts when scale requires it.

### 4.3 Shared packages

`packages/contracts` is the source of truth for schemas shared across boundaries. Runtime validation uses Zod; TypeScript types are inferred from schemas rather than duplicated.

`packages/infra` contains deterministic functions. It does not call model providers or mutate room state. Given validated infrastructure intent and requirements, it returns diagnostics, a stage decision, a deployment plan, a typed graph, and CDK source.

`packages/ui` implements the original Guided Workspace visual language and shared interactive primitives. It must not depend on server internals.

## 5. Guided Workspace experience

The interface uses a persistent project rail with the three product phases: Sketch, Architect, and Deploy. Warm white and graphite neutrals form the base palette. Sage communicates successful or safe state, amber communicates review or risk, and destructive red is reserved for destructive or failed actions. Borders and whitespace provide most hierarchy; shadows are subtle.

This direction is inspired by the restraint and clarity associated with OpenAI interfaces, but it does not copy OpenAI branding, marks, or proprietary assets.

### 5.1 Landing and onboarding

The landing page explains the transformation from sketch to infrastructure and provides one primary action. Onboarding asks for a display name and cursor color, then offers create room, join room, or solo mode.

Creating a room sets a room-scoped owner credential in a secure cookie. A shared join URL contains only the room ID. Joining issues a signed participant credential and never grants owner authority.

### 5.2 Sketch phase

The center is a tldraw canvas. The project rail shows phase status and active participants. A contextual panel contains the requirements profile. A persistent readiness control shows vote counts and the 80 percent threshold.

The whiteboard remains intentionally freeform. AWS vocabulary is not required. Requirements are structured because they affect deterministic staging later.

### 5.3 Architect phase

The center becomes a typed React Flow graph. The contextual panel provides AI architect chat and proposed-patch review. A revision/history view explains who or what changed the graph and why.

Every resource displays its origin:

- `explicit`: represented directly in the source intent
- `inferred-minimal`: added deterministically to make the graph deployable
- `stage-upgrade`: suggested because of scale, availability, or recovery requirements and requiring approval

The semantic graph and visual layout are separate records. Moving a node changes layout, not infrastructure semantics.

### 5.4 Deploy phase

LocalStack and AWS are separate targets. The screen shows the selected immutable architecture revision, synth status, resource changes, approvals, logs, and final outcome.

LocalStack may execute after team consensus. AWS requires team consensus, a successful synthesis, a successfully created change set, a room-owner credential, and a final explicit owner action to execute that change set.

### 5.5 Responsive and accessible behavior

Desktop uses the project rail, main workspace, and contextual panel simultaneously. On smaller screens, the rail becomes a drawer and contextual panels become full-screen sheets. The canvas remains the primary surface.

All primary actions support keyboard navigation and visible focus. Status is communicated with text and icons in addition to color. Motion respects reduced-motion preferences. Automated accessibility checks are supplemented by keyboard and screen-reader-oriented manual checks.

## 6. Identity and authorization

V1 uses frictionless guest rooms rather than account-based authentication.

### 6.1 Participant credential

On join, the server issues a signed, room-scoped participant identifier in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie. Display name and cursor color are collaborative profile data, but the signed identifier prevents clients from impersonating another participant in votes and history events.

### 6.2 Owner credential

Room creation generates a cryptographically random owner token. The raw token is delivered only in a room-scoped secure cookie; PostgreSQL stores a slow hash. The shared room URL does not contain owner authority.

Owner authority is required only for real AWS change-set execution and owner-only room administration. Team consensus remains necessary but is not itself cloud authorization.

## 7. Persistence model

PostgreSQL is the durable product store. Live cursors remain transient awareness state.

Core records are:

- `Room`: identifier, phase, lifecycle timestamps, owner-token hash, current revision
- `Participant`: room-scoped identifier, display profile, join and last-seen timestamps
- `YjsSnapshot`: compressed document snapshot, version, creation time
- `ArchitectureRevision`: immutable semantic graph, view layout, requirements, provenance, author, rationale
- `HistoryEvent`: decision, change, deployment, or system event with actor and status
- `AiRun`: provider, model, task, trace ID, timing, status, token metadata, redacted error
- `DeployJob`: target, revision, state, stack identity, region, approval facts, timestamps
- `DeployLog`: ordered, redacted job log entries

Snapshots are persisted periodically, after important collaborative transitions, and during controlled shutdown. Architecture revisions are created after reconstruction, before and after agent patches, before every synth or deployment, and on manual save.

## 8. Shared infrastructure contracts

The semantic architecture contains resources, relationships, requirements, decisions, and unresolved questions. Canvas positions live in a separate view model.

Each resource includes:

- Stable ID
- Allowlisted AWS resource type
- Human-readable name
- Typed properties
- Origin and reason
- Confidence where applicable
- Approval status

Graph operations are a discriminated union such as `add_resource`, `update_resource`, `remove_resource`, `add_relationship`, and `remove_relationship`. Each operation is schema-validated, authorized, applied transactionally, and recorded in history.

The initial AWS catalog follows the reference and includes external actors, EC2, S3, Lambda, RDS, DynamoDB, VPC, subnet, security group, internet gateway, NAT gateway, route table, API Gateway, SNS, SQS, IAM role, CloudFront, ELB, and MSK. A catalog entry declares whether it is diagram-only, synth-supported, LocalStack-tested, and AWS-tested so unsupported deployment behavior is explicit.

## 9. Reconstruction and staging

The reconstruction pipeline is:

```text
whiteboard capture
→ OpenAI vision request
→ strict InfraIntent structured output
→ runtime validation
→ diagnostics
→ deterministic requirements scoring
→ workload-stage decision
→ provenance-aware deployment plan
→ typed semantic graph
→ architecture revision
```

The OpenAI Responses API is the default integration. Image input is sent as a data URL. Reconstruction uses strict Structured Outputs matching the shared InfraIntent schema. Model defaults are environment-configurable; the initial OpenAI default is `gpt-5.6` for both reconstruction and architect tasks, with separate variables so evaluation can tune them independently.

Anthropic is the only fallback provider. It uses the same internal request and result interfaces and must return the same validated contracts. No Gemini SDK, API key, provider entry, or environment variable is included.

Fallback occurs for timeouts, transient provider failures, refusals, or exhausted model-output repair. It does not hide application validation bugs or invalid requests. The UI reports which provider completed the run without exposing credentials or private prompts.

Requirements deterministically choose `prototype`, `mvp`, `growth`, or `production`. Staging code may add minimally required networking and may propose approval-gated topology upgrades. It never silently converts a stage proposal into an approved resource.

## 10. AI architect

The AI architect receives the current semantic revision, requirements, relevant history, and the user's message. It can explain architecture or invoke strict function tools for typed graph operations.

The server executes every tool call. Before application it verifies:

- The operation schema
- Resource and relationship references
- Resource-type allowlists
- Protected or destructive changes
- Current revision consistency
- Approval requirements

A model cannot run arbitrary shell commands, generate directly executed CDK, access credentials, or invoke AWS. High-impact or destructive patches are presented as a proposed diff and require confirmation. Successful mutations create a revision and history events.

## 11. Collaboration and voting

Yjs stores tldraw records, shared requirements, working graph state, votes, chat presentation state, and phase metadata. Hocuspocus synchronizes the document and awareness.

The server treats transitions as idempotent jobs. When 80 percent of active signed participants vote ready, exactly one reconstruction job may claim the current room version. The accepted capture and requirements are tied to that job's trace ID.

The same principle applies to deployment voting. Duplicate clients or reconnects cannot create duplicate deploy jobs. Solo rooms treat the single participant as the entire active membership.

## 12. Deployment

`packages/infra` generates CDK from a validated, immutable architecture revision. It generates only allowlisted constructs and relationships. Unsupported catalog entries produce blocking diagnostics rather than placeholder infrastructure.

### 12.1 LocalStack

LocalStack is the default target. Docker Compose pins an explicit LocalStack version. The deployment runner prepares an isolated job directory, installs pinned dependencies, compiles, synthesizes, bootstraps when necessary, deploys, and captures bounded logs.

### 12.2 AWS

Real AWS uses the server's default AWS credential chain and an optional `AWS_DEPLOY_ROLE_ARN`. Long-lived AWS keys are never accepted from the browser or stored in room data.

AWS configuration includes allowlisted regions and a stack-name prefix. The flow is:

```text
team vote
→ immutable revision
→ CDK synth
→ CloudFormation template validation
→ create change set
→ display adds/modifies/replacements/deletes
→ verify owner credential
→ explicit owner execution
→ poll stack events
→ persist result and logs
```

Deploy-job states are `queued`, `synthesizing`, `creating_change_set`, `awaiting_owner`, `executing`, `succeeded`, `failed`, and `cancelled`. Cancellation is permitted before change-set execution. Stack failure details are redacted before being shown to clients.

## 13. Error handling and observability

Every request, AI run, reconstruction, revision, and deployment carries a trace ID. Fastify emits structured logs with secret and credential redaction. Health and readiness endpoints distinguish process health from database, collaboration, and job-runner readiness.

Reconstruction errors never silently advance the room. The UI keeps the shared sketch and requirements, displays concise diagnostics, and allows retry after votes are cleared or reconfirmed.

Provider calls have bounded timeouts and retry budgets. Deployment stages have bounded output and explicit timeout policies. Jobs persist state before and after each external operation so restart recovery can reconcile incomplete work instead of assuming success.

Client errors use stable error codes and user-readable messages. Detailed provider, validation, or AWS context stays in redacted server logs associated with the trace ID.

## 14. Security boundaries

- All secrets stay in server-side environment variables or the AWS credential chain.
- `.env` files are ignored; `.env.example` documents names without values.
- Yjs documents, database records, API responses, and logs exclude AI and AWS secrets.
- Whiteboard text and chat are untrusted model input.
- AI output is validated before it reaches product state.
- API payload size, rate, origin, session lifetime, AI concurrency, and deploy concurrency are limited.
- Deployment compiles a typed allowlisted graph rather than arbitrary model-generated source.
- Real AWS execution requires both consensus and owner authorization.
- CloudFormation changes are reviewed before execution.

## 15. Testing strategy

### Unit tests

- Zod schemas and normalization
- Requirement scoring and stage selection
- Minimal inference and stage-upgrade provenance
- Semantic graph validation and operations
- CDK generation and template snapshots
- Owner and participant authorization
- Provider adapter behavior with deterministic fixtures
- Error mapping and redaction

### Integration tests

- Fastify routes against PostgreSQL
- Yjs snapshot persistence and restart recovery
- Presence-aware voting and idempotent phase transitions
- OpenAI-first and Anthropic-fallback orchestration with mocked providers
- Revision and history creation
- Deployment-job state transitions and recovery
- CloudFormation adapter behavior with mocked AWS SDK clients

### Infrastructure tests

Representative supported graphs must synthesize valid CloudFormation. LocalStack tests deploy and inspect a small supported architecture. Real AWS tests are opt-in and restricted to a dedicated sandbox account and stack prefix.

### End-to-end tests

Playwright uses two isolated browser contexts to verify room creation and joining, live collaboration, readiness voting, deterministic mocked reconstruction, graph synchronization, agent patch review, deployment voting, and LocalStack completion.

### Accessibility tests

Automated axe scans cover primary screens. Manual checks cover keyboard-only operation, focus order, dialog behavior, status announcements, reduced motion, and non-color status communication.

Each implementation milestone must finish with its relevant verification commands and a runnable demonstration before the next milestone begins.

## 16. Local and deployment environments

Docker Compose provides:

- Next.js web application
- Fastify/Hocuspocus server
- PostgreSQL
- LocalStack

Local development also supports running web and server directly against containerized PostgreSQL and LocalStack. Environment parsing fails fast with actionable errors.

Production hosting may place web and server behind one reverse proxy and public origin. WebSocket, API, and cookie configuration assume a same-site deployment by default. The server remains a long-lived process because collaboration and deployment jobs are not serverless workloads.

## 17. Repository and delivery rules

The GitHub repository is named `TheArchitect`. The main branch must always represent verified work. Milestones are committed only after their tests pass. Source, migrations, tests, Docker configuration, documentation, and `.env.example` are pushed. Secrets, generated build output, local companion files, deployment work directories, and real credential files are never committed.

Major architectural deviations from this specification require user approval before implementation.

# Task 9 AI Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add strict OpenAI reconstruction and generic architect adapters, an equivalent Anthropic adapter, and one-at-most bounded fallback with redacted terminal run recording.

**Architecture:** Provider adapters accept validated inputs and use provider SDK Zod helpers to derive strict structured-output payloads. Reconstruction uses a provider-local strict wire schema for dynamic resource properties and validates normalized output against the existing shared application schema; architect calls inject a generic protocol until Task 11 supplies graph operations. A failover wrapper owns provider selection and one awaited terminal safe-record callback.

**Tech Stack:** Node.js 22.12+, TypeScript 5.9, Zod 4, Vitest 4, OpenAI JavaScript SDK Responses API, Anthropic TypeScript SDK Messages API, npm workspaces.

## Global Constraints

- OpenAI Responses is primary; Anthropic is the only fallback; no Gemini dependency, key, provider, code path, or environment variable.
- OpenAI models default independently to `gpt-5.6`; Anthropic uses only configured `ANTHROPIC_MODEL` and has no fallback literal.
- Zod runtime schemas are the only source of JSON Schema; no independently hand-written provider schema.
- Generated provider schemas must use `additionalProperties: false` at every object node.
- Validate protocol input before rendering/provider calls; validate reconstruction input as a PNG data URL and an opaque privacy-preserving safety identifier of at most 64 characters.
- Provider adapters never receive or hash raw participant identity.
- Timeout, SDK retries, output repair, and provider fallback are finite and explicit; output repair is iterative, fallback occurs at most once, and only final exhausted `AiOutputError` is eligible.
- Invalid input, invalid configuration, compiler/application validation, recorder failures, non-transient provider failures, and arbitrary injected application errors are never fallback-eligible.
- Adapter SDK boundaries sanitize every raw/unknown SDK throw; no public AI error retains raw message, error, cause, response, request, headers, image, prompt, key, or secret.
- Terminal recording occurs exactly once and is awaited. It contains only trace ID, task, selected provider, configured model, terminal status, and optional stable error code.
- If fallback fails, return the fallback error. If terminal recording fails, return a stable ineligible recorder error and never fallback.
- Do not modify Task 8 contracts or add Task 11 `GraphOperation` prematurely.
- Follow existing dependency conventions: install current official SDK releases with npm's caret direct ranges, commit the exact lockfile resolution, inspect the installed helper exports/types before adapter implementation, and never cast around a missing API surface.

---

## File map

- `apps/server/src/ai/provider.ts` — provider contracts, input schemas, bounded options, provider identities, safe errors, strict-schema assertion.
- `apps/server/src/ai/provider.test.ts` — core input/error/options/schema and generic architect protocol tests.
- `apps/server/src/ai/reconstruction-wire.ts` — provider-local strict reconstruction wire Zod schema and deterministic safe normalization.
- `apps/server/src/ai/reconstruction-wire.test.ts` — dynamic key, duplicate/prototype key, boundary, deterministic order, and final application validation tests.
- `apps/server/src/ai/prompts/reconstruct.ts` — fixed reconstruction and repair instructions.
- `apps/server/src/ai/prompts/architect.ts` — fixed generic architect safety instruction.
- `apps/server/src/ai/openai.provider.ts` — OpenAI Responses adapter and allowlisted SDK error classification.
- `apps/server/src/ai/openai.provider.test.ts` — OpenAI request, parse, refusal, repair, errors, bounds, strict schema, and redaction tests.
- `apps/server/src/ai/anthropic.provider.ts` — Anthropic Messages adapter and allowlisted SDK error classification.
- `apps/server/src/ai/anthropic.provider.test.ts` — Anthropic structured output/image, repair, errors, bounds, strict schema, and redaction tests.
- `apps/server/src/ai/failover.ts` — primary/fallback selection and exactly-once terminal recorder.
- `apps/server/src/ai/failover.test.ts` — eligibility matrix, fallback precedence/bounds, recorder, arbitrary application error, and redaction tests.
- `apps/server/src/config/env.ts` and `apps/server/src/config/env.test.ts` — finite AI timeout/retry/repair environment settings.
- `.env.example` — non-secret AI execution settings.
- `apps/server/package.json` and `package-lock.json` — official OpenAI and Anthropic SDK dependencies.
- `.superpowers/sdd/task-9-report.md` — ignored RED/GREEN and final-gate evidence.

---

### Task 1: Install SDKs and define the safe provider boundary

**Files:**
- Modify: `apps/server/package.json`
- Modify: `package-lock.json`
- Create: `apps/server/src/ai/provider.ts`
- Create: `apps/server/src/ai/provider.test.ts`
- Modify: `apps/server/src/config/env.ts`
- Modify: `apps/server/src/config/env.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `AiProvider`, `ArchitectProtocol<TInput,TOutput>`, `ReconstructionInput`, `ArchitectTurnInput<TInput>`, `AiExecutionOptions`, `AiRunRecorder`, and `ProviderIdentity`.
- Produces: `AiError`, `AiTimeoutError`, `AiRefusalError`, `AiProviderError`, `AiOutputError`, `AiInputError`, `AiConfigurationError`, and `AiRecorderError` with stable codes.
- Produces: `parseReconstructionInput`, `parseArchitectInput`, `parseAiExecutionOptions`, `safeErrorCode`, and `assertStrictObjectSchema`.

- [ ] **Step 1: Install official provider SDK dependencies**

Run:

```bash
npm install --workspace @architect/server openai @anthropic-ai/sdk
```

Expected: `apps/server/package.json` and `package-lock.json` contain only the two new official provider dependencies and their transitive dependencies.

Before writing adapter code, record `npm ls openai @anthropic-ai/sdk zod` and inspect the installed `responses.parse`/`zodTextFormat` and `messages.parse`/`zodOutputFormat` declarations. The lockfile is the reproducible version authority; do not guess APIs from a different release.

- [ ] **Step 2: Write failing boundary/configuration tests**

Create tests that use the wished-for API:

```ts
const options = parseAiExecutionOptions({
  timeoutMs: 10_000,
  maxRetries: 1,
  outputRepairAttempts: 1,
});
expect(options).toEqual({ timeoutMs: 10_000, maxRetries: 1, outputRepairAttempts: 1 });

expect(() => parseReconstructionInput({
  traceId: "trace-1",
  safetyIdentifier: "opaque-room-user-hash",
  imageDataUrl: VALID_PNG,
})).not.toThrow();
expect(() => parseReconstructionInput({
  traceId: "trace-1",
  safetyIdentifier: "x".repeat(65),
  imageDataUrl: VALID_PNG,
})).toThrow(AiInputError);
expect(() => parseReconstructionInput({
  traceId: "trace-1",
  safetyIdentifier: "opaque",
  imageDataUrl: "data:image/jpeg;base64,/9j/",
})).toThrow(AiInputError);
```

Add tests that errors serialize without a raw sentinel/cause/request, arbitrary values map to only `AI_UNKNOWN_ERROR` for recorder metadata, invalid architect protocol input prevents its renderer from running, generated schemas missing recursive `additionalProperties:false` are rejected, and env values outside timeout `1_000..120_000`, retries `0..2`, or repair attempts `0..2` are rejected.

- [ ] **Step 3: Run the boundary tests and verify RED**

Run:

```bash
npm test --workspace @architect/server -- provider.test.ts env.test.ts
```

Expected: FAIL because `apps/server/src/ai/provider.ts` and the new environment fields do not exist.

- [ ] **Step 4: Implement the minimal provider boundary**

Use strict Zod inputs and bounded defaults:

```ts
export const DEFAULT_AI_EXECUTION_OPTIONS = Object.freeze({
  timeoutMs: 60_000,
  maxRetries: 1,
  outputRepairAttempts: 1,
});

export type ArchitectProtocol<TInput, TOutput> = Readonly<{
  name: string;
  systemPrompt: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodObject<z.ZodRawShape>;
  renderInput(input: TInput): string;
}>;

export interface AiProvider {
  identity(task: AiTask): ProviderIdentity;
  reconstruct(input: ReconstructionInput): Promise<InfrastructureIntent>;
  architect<TInput, TOutput>(
    input: ArchitectTurnInput<TInput>,
    protocol: ArchitectProtocol<TInput, TOutput>,
  ): Promise<TOutput>;
}
```

`AiError` constructors accept only trace ID plus stable sanitized fields and never accept `cause` or a raw error. `assertStrictObjectSchema` recursively walks `properties`, `items`, `anyOf`, `oneOf`, and `$defs`; every node with `type: "object"` must have `additionalProperties === false`.

Extend environment parsing and `.env.example` with:

```text
AI_PROVIDER_TIMEOUT_MS=60000
AI_PROVIDER_MAX_RETRIES=1
AI_OUTPUT_REPAIR_ATTEMPTS=1
```

- [ ] **Step 5: Run boundary tests and verify GREEN**

Run: `npm test --workspace @architect/server -- provider.test.ts env.test.ts`

Expected: provider input, safe errors, recursive strictness, generic protocol pre-validation, and bounded environment tests pass.

- [ ] **Step 6: Commit the safe boundary**

```bash
git add apps/server/package.json package-lock.json apps/server/src/ai/provider.ts apps/server/src/ai/provider.test.ts apps/server/src/config/env.ts apps/server/src/config/env.test.ts .env.example
git commit -m "feat: define bounded AI provider contracts"
```

---

### Task 2: Add the strict reconstruction wire format

**Files:**
- Create: `apps/server/src/ai/reconstruction-wire.ts`
- Create: `apps/server/src/ai/reconstruction-wire.test.ts`

**Interfaces:**
- Consumes: shared `awsResourceTypeSchema`, `architectureRelationshipKindSchema`, `infrastructureZoneSchema`, `resourcePropertyValueSchema`, and `infrastructureIntentSchema`.
- Produces: `reconstructionWireSchema`, `ReconstructionWireIntent`, and `normalizeReconstructionWire(value): InfrastructureIntent`.

- [ ] **Step 1: Write failing wire-format tests**

Test a strict wire resource with entries in reverse key order:

```ts
const result = normalizeReconstructionWire({
  version: "infrastructure-intent/v1",
  resources: [{
    type: "S3",
    id: "bucket",
    name: "Uploads",
    count: null,
    zone: null,
    properties: [
      { key: "zeta", value: true },
      { key: "alpha", value: "first" },
    ],
  }],
  relationships: [],
});
expect(Object.keys(result.resources[0]!.properties)).toEqual(["alpha", "zeta"]);
```

Add exact tests for 100 entries accepted, 101 rejected by the wire Zod schema, duplicate keys rejected before normalization, each of `__proto__`, `constructor`, and `prototype` rejected, unknown resource/relationship fields rejected, nullable optional fields omitted during normalization, a wire-valid/application-invalid relationship rejected, and recursively strict generated JSON Schema.

- [ ] **Step 2: Run wire tests and verify RED**

Run: `npm test --workspace @architect/server -- reconstruction-wire.test.ts`

Expected: FAIL because the provider wire module does not exist.

- [ ] **Step 3: Implement strict wire parsing and normalization**

Define strict nullable provider fields and duplicate/prototype checks:

```ts
const propertyEntrySchema = z.strictObject({
  key: z.string().trim().min(1).max(120),
  value: resourcePropertyValueSchema,
});

const wireResourceSchema = z.strictObject({
  type: awsResourceTypeSchema,
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  count: z.number().int().min(1).max(20).nullable(),
  zone: infrastructureZoneSchema.nullable(),
  properties: z.array(propertyEntrySchema).max(100),
});
```

Normalize only after a successful wire parse. Sort entries, create a null-prototype intermediate record with `Object.create(null)`, reject forbidden/duplicate keys before assignment, omit null optional fields, then return `infrastructureIntentSchema.parse(normalized)` through an output-safe error boundary.

- [ ] **Step 4: Run wire tests and verify GREEN**

Run: `npm test --workspace @architect/server -- reconstruction-wire.test.ts`

Expected: all property safety, limits, strictness, deterministic order, and shared-contract validation tests pass.

- [ ] **Step 5: Commit the wire boundary**

```bash
git add apps/server/src/ai/reconstruction-wire.ts apps/server/src/ai/reconstruction-wire.test.ts
git commit -m "feat: add strict reconstruction wire schema"
```

---

### Task 3: Implement the OpenAI Responses adapter

**Files:**
- Create: `apps/server/src/ai/prompts/reconstruct.ts`
- Create: `apps/server/src/ai/prompts/architect.ts`
- Create: `apps/server/src/ai/openai.provider.ts`
- Create: `apps/server/src/ai/openai.provider.test.ts`

**Interfaces:**
- Consumes: `AiProvider`, bounded options, strict reconstruction wire schema, normalizer, and generic `ArchitectProtocol`.
- Produces: `createOpenAiProvider({ apiKey, visionModel, architectModel, execution, client? }): AiProvider`.

- [ ] **Step 1: Write failing OpenAI reconstruction request tests**

Spy on an injected official client and assert:

```ts
expect(client.responses.parse).toHaveBeenCalledWith(
  expect.objectContaining({
    model: "gpt-5.6",
    safety_identifier: "opaque-safety-id",
    input: [expect.objectContaining({
      role: "user",
      content: expect.arrayContaining([
        expect.objectContaining({ type: "input_text" }),
        { type: "input_image", image_url: VALID_PNG, detail: "high" },
      ]),
    })],
    text: { format: expect.objectContaining({ type: "json_schema", strict: true }) },
  }),
  { timeout: 10_000, maxRetries: 1 },
);
```

Assert the emitted format recursively uses `additionalProperties:false`, valid wire output normalizes to shared `InfrastructureIntent`, and neither provider result nor errors/log captures contain prompt/image/key/safety/raw-error sentinels.

- [ ] **Step 2: Write failing OpenAI architect and failure-policy tests**

Use a strict fixture protocol. Assert input validation happens before `renderInput`, only configured architect model is used, response is validated with the fixture output schema, refusal content maps to `AiRefusalError`, allowlisted timeout/connection/408/409/429/5xx map correctly, 400/401/403 map to ineligible `AiProviderError`, and an unknown SDK throw becomes a sanitized ineligible `AiProviderError`.

For invalid/missing parsed output, configure one repair and assert exactly two `responses.parse` calls. Assert intermediate parse errors never escape and final exhaustion returns eligible `AiOutputError`. Refusals and provider errors must make one call only.

- [ ] **Step 3: Run OpenAI tests and verify RED**

Run: `npm test --workspace @architect/server -- openai.provider.test.ts`

Expected: FAIL because the OpenAI adapter and prompt modules do not exist.

- [ ] **Step 4: Implement the OpenAI adapter minimally**

Use the installed official types without `any`. Build formats only with `zodTextFormat`, call `assertStrictObjectSchema` on the helper-emitted schema, and scan `response.output` message content for `{ type: "refusal" }` before accepting `output_parsed`.

Implement one iterative output loop:

```ts
for (let attempt = 0; attempt <= execution.outputRepairAttempts; attempt += 1) {
  const response = await client.responses.parse(requestFor(attempt), {
    timeout: execution.timeoutMs,
    maxRetries: execution.maxRetries,
  });
  if (hasRefusal(response)) throw new AiRefusalError(input.traceId);
  const parsed = parseAndNormalize(response.output_parsed);
  if (parsed.success) return parsed.data;
}
throw new AiOutputError(input.traceId);
```

Catch only around the SDK request. Recognized SDK types map allowlisted; every other SDK-boundary throw becomes a sanitized ineligible `AiProviderError`. Do not include SDK errors as causes.

- [ ] **Step 5: Run OpenAI tests and verify GREEN**

Run: `npm test --workspace @architect/server -- openai.provider.test.ts provider.test.ts reconstruction-wire.test.ts`

Expected: all OpenAI, boundary, and wire tests pass with exact request and attempt bounds.

- [ ] **Step 6: Commit the OpenAI adapter**

```bash
git add apps/server/src/ai/prompts apps/server/src/ai/openai.provider.ts apps/server/src/ai/openai.provider.test.ts
git commit -m "feat: add strict OpenAI AI adapter"
```

---

### Task 4: Implement the Anthropic Messages adapter

**Files:**
- Create: `apps/server/src/ai/anthropic.provider.ts`
- Create: `apps/server/src/ai/anthropic.provider.test.ts`

**Interfaces:**
- Consumes: the same provider, wire, prompts, execution, and protocol boundaries as OpenAI.
- Produces: `createAnthropicProvider({ apiKey, model, execution, client? }): AiProvider` using only the configured model.

- [ ] **Step 1: Write failing Anthropic structured reconstruction tests**

Assert `messages.parse` receives:

```ts
expect(client.messages.parse).toHaveBeenCalledWith(
  expect.objectContaining({
    model: "configured-anthropic-model",
    max_tokens: expect.any(Number),
    system: expect.any(String),
    messages: [{
      role: "user",
      content: expect.arrayContaining([
        expect.objectContaining({ type: "text" }),
        expect.objectContaining({
          type: "image",
          source: expect.objectContaining({ media_type: "image/png", type: "base64" }),
        }),
      ]),
    }],
    output_config: { format: expect.any(Object) },
  }),
  { timeout: 10_000, maxRetries: 1 },
);
```

Verify the installed SDK type/current official API supports `metadata.user_id` before including the opaque identifier; otherwise assert metadata is omitted. Never cast to force metadata.

- [ ] **Step 2: Write failing Anthropic architect, repair, and error tests**

Mirror OpenAI's fixture protocol, recursive strictness, runtime validation, one-repair/two-call ceiling, final-only eligible `AiOutputError`, refusal, timeout/transient allowlist, non-transient sanitization, configured-model-only, unknown SDK throw sanitization, and sentinel redaction assertions. Inspect refusal using the installed official response type/stop reason rather than message matching.

- [ ] **Step 3: Run Anthropic tests and verify RED**

Run: `npm test --workspace @architect/server -- anthropic.provider.test.ts`

Expected: FAIL because the Anthropic adapter does not exist.

- [ ] **Step 4: Implement the Anthropic adapter minimally**

Use `messages.parse`, `output_config: { format: zodOutputFormat(schema) }`, the installed official request options, and a base64 image source obtained only after validated PNG input. Call the same recursive strict-schema assertion on the helper-emitted schema. Use the same iterative output repair policy and shared normalizer.

Map only official Anthropic timeout/connection/rate-limit/conflict/5xx types as eligible. Sanitize every other SDK-boundary throw into an ineligible `AiProviderError` without a raw cause or message.

- [ ] **Step 5: Run Anthropic tests and verify GREEN**

Run: `npm test --workspace @architect/server -- anthropic.provider.test.ts provider.test.ts reconstruction-wire.test.ts`

Expected: all Anthropic, boundary, and wire tests pass.

- [ ] **Step 6: Commit the Anthropic adapter**

```bash
git add apps/server/src/ai/anthropic.provider.ts apps/server/src/ai/anthropic.provider.test.ts
git commit -m "feat: add strict Anthropic AI adapter"
```

---

### Task 5: Add bounded failover and terminal safe recording

**Files:**
- Create: `apps/server/src/ai/failover.ts`
- Create: `apps/server/src/ai/failover.test.ts`

**Interfaces:**
- Consumes: `AiProvider`, provider identity by task, stable AI errors, and `AiRunRecorder`.
- Produces: `createFailoverProvider(primary, fallback, { recordTerminal }): AiProvider`.

- [ ] **Step 1: Write failing eligibility and precedence tests**

Table-test primary errors:

```ts
it.each([
  [new AiTimeoutError("trace-1"), true],
  [new AiRefusalError("trace-1"), true],
  [new AiProviderError("trace-1", "AI_PROVIDER_TRANSIENT", true), true],
  [new AiOutputError("trace-1"), true],
  [new AiInputError("trace-1"), false],
  [new AiConfigurationError("trace-1"), false],
  [new Error("application sentinel"), false],
])("falls back only for explicit eligibility", async (error, expected) => {
  primary.reconstruct.mockRejectedValue(error);
  // assert fallback count and returned/thrown value
});
```

Assert fallback is called at most once, a fallback error replaces the primary error, and no recursive provider selection exists.

- [ ] **Step 2: Write failing terminal recorder/redaction tests**

For primary success/noneligible failure, fallback success/failure, arbitrary injected provider error, and recorder failure, assert the recorder is awaited and called exactly once with only:

```ts
{
  traceId: "trace-1",
  task: "reconstruct",
  provider: "anthropic",
  model: "configured-anthropic-model",
  status: "succeeded",
}
```

On failure add only a stable `errorCode`. Assert primary identity is recorded for primary terminal outcomes and fallback identity for fallback terminal outcomes. An arbitrary non-`AiError` is preserved after recording but records `AI_UNKNOWN_ERROR`. Recorder rejection returns `AiRecorderError`, includes no cause/raw message, and never invokes fallback.

- [ ] **Step 3: Run failover tests and verify RED**

Run: `npm test --workspace @architect/server -- failover.test.ts`

Expected: FAIL because failover orchestration does not exist.

- [ ] **Step 4: Implement failover and exactly-once recording**

Select the terminal provider first, then record once through a discriminated settled result:

```ts
type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

let selected = primary;
let settled: Settled<T>;
try {
  settled = { ok: true, value: await operation(primary) };
} catch (primaryError) {
  if (fallback && primaryError instanceof AiError && primaryError.fallbackEligible) {
    selected = fallback;
    try {
      settled = { ok: true, value: await operation(fallback) };
    } catch (error) {
      settled = { ok: false, error };
    }
  } else {
    settled = { ok: false, error: primaryError };
  }
}
await recordOnce(
  selected.identity(task),
  traceId,
  task,
  settled.ok ? undefined : settled.error,
);
if (!settled.ok) throw settled.error;
return settled.value;
```

Catch recorder failure separately and throw a new stable ineligible `AiRecorderError`.

- [ ] **Step 5: Run all Task 9 focused tests and verify GREEN**

Run:

```bash
npm test --workspace @architect/server -- provider.test.ts reconstruction-wire.test.ts openai.provider.test.ts anthropic.provider.test.ts failover.test.ts env.test.ts
```

Expected: all provider boundary, adapter, repair, failover, recorder, strictness, and redaction tests pass.

- [ ] **Step 6: Commit failover**

```bash
git add apps/server/src/ai/failover.ts apps/server/src/ai/failover.test.ts
git commit -m "feat: add bounded AI provider failover"
```

---

### Task 6: Verify, review, report, and finalize Task 9

**Files:**
- Modify: `.superpowers/sdd/task-9-report.md` (ignored evidence file)
- Modify only if a failing regression test proves a Task 9 defect: Task 9 files above.

**Interfaces:**
- Produces: verified Task 9 evidence, a clean focused commit range, and no push.

- [ ] **Step 1: Run focused and adjacent suites**

```bash
npm test --workspace @architect/server -- provider.test.ts reconstruction-wire.test.ts openai.provider.test.ts anthropic.provider.test.ts failover.test.ts env.test.ts
npm test --workspace @architect/contracts -- infrastructure.test.ts
npm test --workspace @architect/infra -- catalog.test.ts staging.test.ts compiler.test.ts
npm test --workspace @architect/server
```

Expected: all tests pass; record exact counts.

- [ ] **Step 2: Request focused code review and process findings**

Review the Task 9 commit range against the approved design and plan. For every finding, verify it in the current code, add an exact failing regression test, observe RED, implement the smallest fix, and observe GREEN. Do not implement speculative or out-of-scope review suggestions.

- [ ] **Step 3: Run repository gates from fresh state**

```bash
npm test
npm run lint
npm run typecheck
npm run build
npm run typecheck
git diff --check
```

Expected: full repository tests, lint, typecheck, production build, fresh post-build typecheck, and diff check pass. Run full server tests outside the sandbox only if local port binding is blocked.

- [ ] **Step 4: Run dependency and security scans**

```bash
npm audit
rg -n -i 'gemini|google-generative|openrouter' package.json package-lock.json apps packages .env.example
rg -n 'sk-[A-Za-z0-9_-]{16,}|OPENAI_API_KEY=.+|ANTHROPIC_API_KEY=.+' . --glob '!node_modules/**' --glob '!.git/**'
rg -n 'console\.|logger\.|prompt|imageDataUrl|base64|apiKey|safetyIdentifier|cause' apps/server/src/ai
find . -type f \( -name '*.pem' -o -name '*.key' -o -name '.env' -o -name '.env.*' -o -name '* 2.ts' \) -not -path './node_modules/*' -not -path './.git/*'
git status --short --ignored
```

Expected: no Gemini/provider drift, credential literals, unsafe logging, or generated/credential artifacts. If live audit is blocked by network or policy, record the exact command/error and inspect the unchanged lockfile without bypassing policy.

- [ ] **Step 5: Update evidence and finalize commits**

Record each RED failure reason, GREEN command/count, review remediation, full gate, scan, audit result/limitation, dependency versions, and residual risk in `.superpowers/sdd/task-9-report.md`. Stage only Task 9 tracked files; inspect `git diff --cached --check`, `--stat`, and `--name-only`; commit any verified review remediation with a focused message. Do not push.

- [ ] **Step 6: Confirm final branch state**

```bash
git status --short --branch
git log --oneline --decorate -12
git rev-parse HEAD
```

Expected: no tracked or untracked Task 9 changes, ignored evidence report present, branch ahead only by intentional Task 9 commits, and no push performed.

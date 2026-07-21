# Task 9 AI Provider Boundary Design

**Date:** 2026-07-21

**Status:** Approved for implementation

## Scope

Task 9 adds an OpenAI-first, Anthropic-fallback server-side AI boundary for whiteboard reconstruction and future architect turns. It does not add reconstruction jobs, graph-operation contracts, architect routes, persistence repositories, or browser-facing provider code. Those remain in Tasks 10–12.

The provider layer must return only runtime-validated application values. It never exposes prompts, image data, safety identifiers, credentials, raw SDK responses, or raw provider errors through errors, logs, run metadata, or public return envelopes.

## Contract sequencing

`GraphOperation` is created by Task 11, while Task 9 must establish `AiProvider.architect`. Task 9 therefore does not create a provisional graph-operation contract.

Instead, architect calls use an injected generic `ArchitectProtocol<TInput, TOutput>`. The protocol owns:

- a fixed system prompt;
- a strict runtime Zod input schema;
- a strict root-object runtime Zod output schema;
- a stable provider schema name; and
- a deterministic input renderer that receives only the already-validated input.

Zod schemas are the only schema source of truth. Provider SDK helpers derive strict provider payloads from them. The implementation must reject a protocol before a request if its generated schema contains any object node without `additionalProperties: false`. No independently maintained JSON Schema is permitted.

Task 9 tests bind a minimal fixture protocol. Task 12 will bind the real architect input/output schemas after Task 11 supplies `GraphOperation`.

## Components

### Provider contract

`provider.ts` defines:

- `ReconstructionInput`, including trace ID, opaque privacy-preserving safety identifier, and PNG data URL;
- generic `ArchitectTurnInput<TInput>` and `ArchitectProtocol<TInput, TOutput>`;
- `AiProvider`, whose architect method is generic over an injected protocol;
- immutable public provider identity containing only provider name and configured model;
- terminal run metadata and an awaited terminal recorder callback;
- bounded execution options with finite timeout, SDK retries, and output-repair attempts; and
- stable sanitized AI error classes.

Input is validated before prompt rendering or a provider call. Reconstruction accepts only a PNG base64 data URL. `safetyIdentifier` is already privacy-preserving at this boundary, is treated as opaque, and is limited to 64 characters. The provider never receives or hashes a raw participant identifier.

### OpenAI adapter

The OpenAI adapter uses the official server SDK and Responses API parsing helper:

- `responses.parse`;
- `zodTextFormat` under `text.format`;
- a user content array containing fixed reconstruction text and an `input_image` PNG data URL;
- configured `OPENAI_VISION_MODEL` or `OPENAI_AGENT_MODEL` only;
- the opaque `safety_identifier`; and
- explicit per-request timeout and retry bounds.

It scans message content for refusal blocks before accepting parsed output. Parsed output is validated again with the source Zod schema. It does not log or return the SDK response.

### Strict reconstruction wire format

The shared application contract intentionally represents resource properties as a dynamic record. Strict provider Structured Outputs do not permit that record's generated `additionalProperties` value schema. Task 9 therefore owns a narrow provider-wire Zod schema rather than changing the Task 8 application contract.

The wire schema uses strict root, resource, relationship, and property-entry objects. A resource's `properties` is an array of at most 100 strict entries shaped as `{ key, value }`, where `key` is nonempty and at most 120 characters and `value` reuses the shared `resourcePropertyValueSchema`. Shared exported enums, literals, and compatible relationship fields are reused rather than copied.

Before normalization, the adapter rejects duplicate keys and prototype-sensitive keys such as `__proto__`, `constructor`, and `prototype`. It sorts entries by key and builds the application property record without assignment through an inherited prototype. The normalized result is then validated by the shared `infrastructureIntentSchema`, which remains authoritative for final limits and semantics. Wire-valid but application-invalid output consumes the same bounded output-repair budget and becomes `AiOutputError` only after that budget is exhausted.

### Anthropic adapter

The Anthropic adapter uses the official server SDK with structured output through `messages.parse`, `output_config.format`, and the SDK's Zod output helper. It uses only configured `ANTHROPIC_MODEL`; there is no fallback model literal.

The adapter sends reconstructed image bytes through the SDK's image content shape only after validating the PNG data URL. It validates structured output again with the source Zod schema. A user metadata identifier is sent only if the installed SDK type and current official API support it; otherwise it is omitted without casts.

### Failover and run recording

`createFailoverProvider` calls the primary first and can call the fallback at most once. It retries through fallback only for an `AiError` explicitly marked eligible:

- timeout;
- recognized transient provider failure;
- refusal; or
- exhausted bounded output repair.

It never falls back for invalid input, invalid configuration, compiler or application validation failures, recorder failures, arbitrary unknown errors, or recognized non-transient provider errors. If fallback fails, its error is returned instead of the primary error.

The failover wrapper invokes one awaited terminal recorder callback per logical call:

- primary identity for primary success or a terminal primary failure;
- fallback identity for fallback success or failure.

The callback receives a closed record containing only trace ID, task, provider, model, terminal status, and an optional stable error code. It never receives prompt text, input payloads, images, raw/base64 data URLs, safety identifiers, credentials, cookies, SDK errors, raw provider messages, or causes. Recorder failure becomes a stable ineligible error and never triggers fallback.

## Error and attempt policy

Public `AiError` instances contain and enumerate only a stable class name, stable code, sanitized message, trace ID, and `fallbackEligible`. They do not retain a raw error, provider message, cause, request, response, headers, or credentials.

Adapter-owned SDK call boundaries never rethrow unknown or raw SDK errors. SDK error classification is allowlisted by official SDK error types and status classes. Recognized timeout and transient types map to eligible stable errors. Recognized non-transient types and unknown SDK throws map to a stable ineligible `AiProviderError` without retaining the raw message or cause. Authentication, permission, malformed-request, schema/configuration, and other non-transient failures are sanitized and ineligible.

The failover wrapper is a separate application boundary. If an injected application provider throws an arbitrary non-`AiError`, failover preserves that application error as ineligible and does not call fallback. Its terminal recorder still receives only a stable generic error code, never the thrown value or its message.

Every provider request has a positive finite timeout, a small finite SDK `maxRetries`, and a small finite output-repair count. Invalid structured output uses an iterative loop, never recursion. Intermediate output/Zod failures stay internal and are not fallback-eligible; only the final exhausted `AiOutputError` is eligible. Refusal and non-output provider failures do not enter repair. Defaults and accepted maxima make the total provider attempt ceiling explicit: `(initial output attempt + repair attempts) × (initial SDK attempt + SDK retries)`. The configuration parser rejects values outside those bounds.

## Prompt and data flow

Reconstruction:

```text
validated trace/safety/image input
→ fixed server prompt + image content
→ provider strict reconstruction-wire structured-output request
→ refusal check
→ duplicate/prototype-key rejection and deterministic property normalization
→ shared application Zod validation
→ InfrastructureIntent
```

Architect:

```text
validated common call fields
→ protocol input Zod validation
→ deterministic protocol renderer
→ fixed protocol prompt + rendered input
→ provider helper-derived strict output schema
→ refusal check
→ protocol output Zod validation
→ generic protocol output
```

Failover wraps either flow, selects at most two providers, records exactly one terminal safe record, and returns the validated value or terminal sanitized error.

## Testing

Tests use injected SDK-shaped clients and never call live providers. They cover:

- OpenAI image input, `responses.parse`, `text.format`, configured model, safety identifier, timeout, retries, strict schema, and successful parse;
- OpenAI and Anthropic refusal, timeout, transient, non-transient, missing output, invalid schema, and bounded repair behavior;
- adapter sanitization of unknown SDK throws versus failover preservation of injected application-provider errors, with only a generic stable recorder code;
- Anthropic structured output, configured model only, image input, timeout, retries, and strict schema;
- reconstruction properties with dynamic keys, duplicate and prototype-sensitive key rejection, the 100-entry boundary, 101-entry rejection, and order-independent deterministic normalization;
- generic architect fixture input validation before rendering and provider calls;
- recursive assertions that every emitted object schema uses `additionalProperties: false`;
- one eligible fallback at most, no ineligible fallback, and fallback-error precedence;
- exactly-once awaited terminal recording with the selected provider identity;
- recorder failure remaining ineligible;
- attempts bounded under repair and fallback; and
- sentinel scans proving that prompts, raw images/data URLs, API keys, safety identifiers, raw SDK messages, and provider secrets do not occur in result metadata, safe errors, or captured logs.

Focused adapter/failover tests are followed by server, contracts, compiler/infra, repository, lint, typecheck, production build, fresh post-build typecheck, dependency/provider/Gemini/credential/logging/artifact/diff scans, and `npm audit` when policy permits.

## Deferred integration

Task 10 owns reconstruction job persistence. Task 11 owns `GraphOperation`. Task 12 owns the concrete architect protocol, graph-operation validation/application, proposal persistence, and route/UI behavior. Those tasks can consume the generic boundary without changing provider adapter internals.

# Compiler Generated Graph Budgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make bounded high-cardinality intent compilation return a deterministic, schema-valid capped graph and stable blocking diagnostics instead of throwing when generated inference reaches architecture limits.

**Architecture:** Use admission control at the compiler's two sole graph creation boundaries. Explicit expansion and generated resources share the exact 400-resource budget, while every relationship continues through the exact 1,000-edge guard; generated callers stop dependent work when admission returns `undefined`.

**Tech Stack:** TypeScript, Zod contract schemas, Vitest, npm workspaces.

## Global Constraints

- Preserve the contract maxima of exactly 400 architecture resources and 1,000 architecture relationships.
- Preserve every explicit resource and relationship that fits the architecture contract before admitting generated additions.
- Emit at most one stable blocking diagnostic for each exceeded budget.
- Do not reserve arbitrary capacity, weaken schemas, truncate completed graphs, add dependencies, or push commits.
- Produce one focused implementation commit after all gates pass.

---

### Task 1: Add exact high-cardinality RED coverage

**Files:**
- Modify: `packages/infra/src/compiler.test.ts`

**Interfaces:**
- Consumes: `compileIntent`, `materializeApprovedArchitecture`, and `architectureSchema`.
- Produces: exact resource-budget and strengthened relationship-budget regressions.

- [ ] **Step 1: Add the 81 VPC/ELB pair regression**

Construct 81 deterministic `{VPC, ELB}` pairs and one explicit `contains` edge
per pair. Compile twice and assert the call does not throw, both results match,
all 162 explicit resource IDs and 81 explicit relationship facts survive, the
resource count is at most 400, IDs are unique, every edge endpoint exists,
materialization parses, and exactly one `ARCHITECTURE_RESOURCE_LIMIT` error
identifies the first rejected generated resource.

- [ ] **Step 2: Strengthen the existing 1,200-edge regression**

Capture two compilations of the existing 20-by-20 three-label fan-out. Assert
no throw, identical output, at most 1,000 relationships, unique relationship
IDs, valid endpoints, schema validity, and exactly one
`ARCHITECTURE_RELATIONSHIP_LIMIT` error.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
npm test --workspace @architect/infra -- compiler.test.ts -t "caps owner-local generated resources|caps schema-valid high-cardinality expansions"
```

Expected: the 81-pair case throws Zod `too_big` because generated resources
exceed 400; the existing relationship path remains a green characterization.

---

### Task 2: Enforce central graph admission

**Files:**
- Modify: `packages/infra/src/compiler.ts`
- Test: `packages/infra/src/compiler.test.ts`

**Interfaces:**
- Consumes: sorted compiler traversal and the contract maxima.
- Produces: `addGeneratedResource(...): WorkingResource | undefined` with safe caller behavior.

- [ ] **Step 1: Replace the arbitrary explicit reserve with the exact contract maximum**

Rename the resource constant to `MAX_ARCHITECTURE_RESOURCES` and set it to
`400`. Keep explicit expansion admission before generated inference.

- [ ] **Step 2: Add a single stable resource-limit reporter**

Create one closure that records only the first error:

```ts
const reportResourceLimit = (resourceId: string): void => {
  if (resourceLimitReported) return;
  diagnostics.push({
    level: "error",
    code: "ARCHITECTURE_RESOURCE_LIMIT",
    message: `Architecture reached the ${MAX_ARCHITECTURE_RESOURCES}-resource contract limit; ${resourceId} and dependent generated topology were skipped.`,
    path: "resources",
    resourceId,
    suggestion: "Reduce repeated resources or split the architecture into bounded revisions.",
  });
  resourceLimitReported = true;
};
```

Use the same reporter for explicit expansion overflow and generated rejection so
only one stable diagnostic is emitted.

- [ ] **Step 3: Guard generated resource admission before reserving an ID**

Change `addGeneratedResource` to return `WorkingResource | undefined`. Before
calling `reserveId`, check `resources.length >= MAX_ARCHITECTURE_RESOURCES`,
report the rejected `requestedId`, and return `undefined`. This prevents skipped
IDs from perturbing later deterministic ID allocation.

- [ ] **Step 4: Stop dependent generated branches safely**

Guard the replica lineage write and every owner-scoped subnet/security-group
caller that inserts the returned object into arrays, maps, containment sets, or
relationships:

```ts
const subnet = addGeneratedResource(input);
if (!subnet) return;
```

For the ELB subnet `while` loop, return when admission fails. Ignored-return
global inference calls need no dependent changes; `stagedIngress` already
accepts `undefined`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Task 1 command again. Expected: both resource and relationship budget
regressions pass with no throw and one stable diagnostic each.

- [ ] **Step 6: Run named adjacency regressions**

Run focused tests for the 11-EC2 high-card proposal, owner-local VPC inference,
materialization, all named network-placement probes, and deterministic input
ordering. Expected: all selected tests pass.

---

### Task 3: Verify, document, and commit

**Files:**
- Modify: `.superpowers/sdd/task-8-report.md` (ignored evidence file)
- Include: `docs/superpowers/specs/2026-07-21-compiler-generated-graph-budgets-design.md`
- Include: `docs/superpowers/plans/2026-07-21-compiler-generated-graph-budgets.md`
- Include: `packages/infra/src/compiler.ts`
- Include: `packages/infra/src/compiler.test.ts`

**Interfaces:**
- Consumes: the completed central budget behavior.
- Produces: fresh verification evidence and one local focused commit.

- [ ] **Step 1: Run compiler, infra, contracts, lint, and typecheck gates**

```bash
npm test --workspace @architect/infra -- compiler.test.ts
npm test --workspace @architect/infra -- catalog.test.ts staging.test.ts compiler.test.ts
npm test --workspace @architect/contracts
npm run lint
npm run typecheck
```

- [ ] **Step 2: Run full repository tests and production build**

```bash
npm test
npm run build
npm run typecheck
```

The full test command may require approved local port binding. After the build,
scan for duplicate ignored `.next/types/* 2.ts` artifacts and remove only exact
generated duplicates before repeating typecheck if necessary.

- [ ] **Step 3: Run final integrity scans**

Run `git diff --check`, verify dependency/config diffs are empty, scan for
credential/provider/randomness/TODO drift, confirm no dangling generated
artifacts, and inspect the staged file list.

- [ ] **Step 4: Update Task 8 evidence**

Record the exact resource RED, relationship characterization, implementation
semantics, final test counts, unchanged advisory-audit limitation, and artifact
cleanup status in `.superpowers/sdd/task-8-report.md`.

- [ ] **Step 5: Commit without pushing**

```bash
git add packages/infra/src/compiler.ts packages/infra/src/compiler.test.ts \
  docs/superpowers/specs/2026-07-21-compiler-generated-graph-budgets-design.md \
  docs/superpowers/plans/2026-07-21-compiler-generated-graph-budgets.md
git commit -m "fix: cap generated architecture growth"
```

Verify the branch is clean, report the exact commit hash and gate counts, and do
not push.

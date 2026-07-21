# Compiler Generated Graph Budgets Design

## Goal

Compile every bounded, schema-valid intent without throwing when deterministic
inference would exceed the architecture contract's 400-resource or
1,000-relationship limits.

## Approved design

The compiler will use central admission control at graph creation boundaries.
Explicit resource expansion may use the full 400-resource architecture budget;
there is no reserved generated-resource allowance. `addGeneratedResource` will
admit a generated resource only while the exact contract budget has capacity and
otherwise return `undefined`. The first rejected resource records one stable,
blocking `ARCHITECTURE_RESOURCE_LIMIT` diagnostic that identifies the rejected
generated ID and explains the 400-resource limit. Later rejections do not add
duplicate limit diagnostics.

Every caller that needs the returned generated resource will treat `undefined`
as a stopped inference branch. It will not add the skipped resource to typed
candidate collections, ownership maps, replica lineage, or dependent generated
relationships. Explicit resources and relationships already reconstructed from
the intent remain unchanged.

All relationship writes already flow through `addRelationship`. That boundary
will retain the exact 1,000-relationship contract maximum and its single stable
`ARCHITECTURE_RELATIONSHIP_LIMIT` diagnostic. No schema limit will be weakened,
and neither resource nor relationship output will be truncated after graph
construction.

## Determinism and validation

Resource admission follows the compiler's existing sorted traversal, so the
first rejected generated ID and final graph are stable across repeated runs.
The result must contain unique resource and relationship IDs, no relationship
whose endpoint was skipped, valid deployment/materialized architectures, and no
aliases caused by rejected ID reservation.

## Regression coverage

An exact 81-pair intent will provide 81 explicit VPCs, 81 explicit ELBs, and 81
explicit containment relationships. Owner-local inference would otherwise add
243 resources and exceed 400. The regression will assert no throw, all 162
explicit resources and all 81 explicit relationships preserved, at most 400
resources, exactly one useful resource-limit diagnostic, deterministic repeated
output, unique IDs, valid endpoints, schema validity, and safe materialization.

The existing 1,200-expanded-edge regression will be strengthened to assert no
throw, deterministic schema-valid output of at most 1,000 relationships,
exactly one stable relationship-limit diagnostic, unique IDs, and no dangling
endpoints. Existing high-cardinality stage proposals, owner-local inference,
the 16 named topology probes, exhaustive requirements matrix, and full project
gates remain required.

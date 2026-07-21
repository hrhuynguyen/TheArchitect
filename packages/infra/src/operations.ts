import {
  ArchitectOperationSchema,
  ArchitectureSchema,
  DestructiveConfirmationSchema,
  GraphOperationBatchSchema,
  type ArchitectOperation,
  type Architecture,
  type ArchitectureRelationship,
  type ArchitectureResource,
  type DestructiveConfirmation,
  type Diagnostic,
  type GraphOperation,
} from "@architect/contracts";

import { RESOURCE_CATALOG } from "./catalog.js";

export type OperationResult =
  | Readonly<{
      ok: true;
      architecture: Architecture;
      diagnostics: readonly Diagnostic[];
    }>
  | Readonly<{
      ok: false;
      architecture: Architecture;
      diagnostics: readonly Diagnostic[];
    }>;

class OperationFailure extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.name = "OperationFailure";
  }
}

function fail(
  code: string,
  message: string,
  reference: Readonly<{
    path?: string;
    resourceId?: string;
    relationshipId?: string;
  }> = {},
): never {
  throw new OperationFailure({
    level: "error",
    code,
    message,
    suggestion: "Refresh the working graph and submit a valid operation batch.",
    ...reference,
  });
}

function resourceById(
  architecture: Architecture,
  resourceId: string,
): ArchitectureResource {
  const resource = architecture.resources.find(
    (candidate) => candidate.id === resourceId,
  );
  if (!resource) {
    return fail(
      "OPERATION_RESOURCE_NOT_FOUND",
      `Resource ${resourceId} does not exist.`,
      { resourceId },
    );
  }
  return resource;
}

function relationshipById(
  architecture: Architecture,
  relationshipId: string,
): ArchitectureRelationship {
  const relationship = architecture.relationships.find(
    (candidate) => candidate.id === relationshipId,
  );
  if (!relationship) {
    return fail(
      "OPERATION_RELATIONSHIP_NOT_FOUND",
      `Relationship ${relationshipId} does not exist.`,
      { relationshipId },
    );
  }
  return relationship;
}

type OperationPolicy = "manual" | "architect";

function applyOne(
  architecture: Architecture,
  operation: GraphOperation,
  policy: OperationPolicy,
): void {
  switch (operation.type) {
    case "add_resource": {
      const { resource } = operation;
      if (architecture.resources.some((candidate) => candidate.id === resource.id)) {
        fail(
          "OPERATION_DUPLICATE_RESOURCE",
          `Resource ${resource.id} already exists.`,
          { resourceId: resource.id },
        );
      }
      if (
        resource.origin !==
          (policy === "manual" ? "explicit" : "inferred-minimal") ||
        resource.approvalStatus !== "not-required" ||
        !RESOURCE_CATALOG[resource.type].diagramSupported
      ) {
        fail(
          "OPERATION_RESOURCE_NOT_MANUAL",
          policy === "manual"
            ? `Resource ${resource.id} cannot be added as a manual catalog resource.`
            : `Resource ${resource.id} does not have trusted architect provenance.`,
          { resourceId: resource.id },
        );
      }
      architecture.resources.push(resource);
      return;
    }
    case "update_resource": {
      const resource = resourceById(architecture, operation.resourceId);
      if (operation.changes.name !== undefined) {
        resource.name = operation.changes.name;
      }
      if (operation.changes.properties !== undefined) {
        resource.properties = operation.changes.properties;
      }
      if (operation.changes.zone === null) delete resource.zone;
      else if (operation.changes.zone !== undefined) {
        resource.zone = operation.changes.zone;
      }
      return;
    }
    case "remove_resource": {
      resourceById(architecture, operation.resourceId);
      architecture.resources = architecture.resources.filter(
        (resource) => resource.id !== operation.resourceId,
      );
      architecture.relationships = architecture.relationships.filter(
        (relationship) =>
          relationship.sourceId !== operation.resourceId &&
          relationship.targetId !== operation.resourceId,
      );
      return;
    }
    case "add_relationship": {
      const { relationship } = operation;
      if (
        architecture.relationships.some(
          (candidate) => candidate.id === relationship.id,
        )
      ) {
        fail(
          "OPERATION_DUPLICATE_RELATIONSHIP",
          `Relationship ${relationship.id} already exists.`,
          { relationshipId: relationship.id },
        );
      }
      if (
        relationship.origin !==
          (policy === "manual" ? "explicit" : "inferred-minimal") ||
        relationship.approvalStatus !== "not-required"
      ) {
        fail(
          "OPERATION_RELATIONSHIP_NOT_MANUAL",
          policy === "manual"
            ? `Relationship ${relationship.id} cannot be added manually.`
            : `Relationship ${relationship.id} does not have trusted architect provenance.`,
          { relationshipId: relationship.id },
        );
      }
      const sourceExists = architecture.resources.some(
        (resource) => resource.id === relationship.sourceId,
      );
      const targetExists = architecture.resources.some(
        (resource) => resource.id === relationship.targetId,
      );
      if (
        !sourceExists ||
        !targetExists ||
        relationship.sourceId === relationship.targetId
      ) {
        fail(
          "OPERATION_DANGLING_RELATIONSHIP",
          `Relationship ${relationship.id} does not have two valid endpoints.`,
          { relationshipId: relationship.id },
        );
      }
      const semanticDuplicate = architecture.relationships.some(
        (candidate) =>
          candidate.sourceId === relationship.sourceId &&
          candidate.targetId === relationship.targetId &&
          candidate.kind === relationship.kind &&
          candidate.label === relationship.label,
      );
      if (semanticDuplicate) {
        fail(
          "OPERATION_RELATIONSHIP_CONFLICT",
          `Relationship ${relationship.id} duplicates an existing graph edge.`,
          { relationshipId: relationship.id },
        );
      }
      architecture.relationships.push(relationship);
      return;
    }
    case "remove_relationship": {
      relationshipById(architecture, operation.relationshipId);
      architecture.relationships = architecture.relationships.filter(
        (relationship) => relationship.id !== operation.relationshipId,
      );
      return;
    }
    case "set_resource_approval": {
      const resource = resourceById(architecture, operation.resourceId);
      if (
        resource.origin !== "stage-upgrade" ||
        resource.approvalStatus !== "pending"
      ) {
        fail(
          "OPERATION_APPROVAL_CONFLICT",
          `Resource ${resource.id} is not a pending stage upgrade.`,
          { resourceId: resource.id },
        );
      }
      resource.approvalStatus = operation.approvalStatus;
      for (const relationship of architecture.relationships) {
        if (
          relationship.origin !== "stage-upgrade" ||
          relationship.approvalStatus !== "pending" ||
          (relationship.sourceId !== resource.id &&
            relationship.targetId !== resource.id)
        ) continue;
        if (operation.approvalStatus === "rejected") {
          relationship.approvalStatus = "rejected";
          continue;
        }
        const stageEndpoints = architecture.resources.filter(
          (candidate) =>
            (candidate.id === relationship.sourceId ||
              candidate.id === relationship.targetId) &&
            candidate.origin === "stage-upgrade",
        );
        if (
          stageEndpoints.every(
            (candidate) => candidate.approvalStatus === "approved",
          )
        ) {
          relationship.approvalStatus = "approved";
        }
      }
      return;
    }
  }
}

export function applyOperations(
  architectureInput: Architecture,
  operationsInput: GraphOperation[],
): OperationResult {
  return applyGraphOperations(architectureInput, operationsInput, "manual");
}

function invalidOperationResult(
  architecture: Architecture,
  code = "OPERATION_INVALID",
  message = "The graph operation batch is invalid.",
): OperationResult {
  return Object.freeze({
    ok: false,
    architecture,
    diagnostics: Object.freeze([
      Object.freeze({
        level: "error" as const,
        code,
        message,
        path: "operations",
        suggestion: "Submit a strict, bounded graph operation batch.",
      }),
    ]),
  });
}

function applyGraphOperations(
  architectureInput: Architecture,
  operationsInput: GraphOperation[],
  policy: OperationPolicy,
): OperationResult {
  const architecture = ArchitectureSchema.parse(architectureInput);
  const parsedOperations = GraphOperationBatchSchema.safeParse(operationsInput);
  if (!parsedOperations.success) {
    return invalidOperationResult(architecture);
  }

  const draft = structuredClone(architecture);
  try {
    for (const operation of parsedOperations.data) {
      applyOne(draft, operation, policy);
    }
  } catch (error) {
    if (!(error instanceof OperationFailure)) throw error;
    return Object.freeze({
      ok: false,
      architecture,
      diagnostics: Object.freeze([Object.freeze(error.diagnostic)]),
    });
  }

  const parsed = ArchitectureSchema.safeParse(draft);
  if (!parsed.success) {
    return Object.freeze({
      ok: false,
      architecture,
      diagnostics: Object.freeze([
        Object.freeze({
          level: "error" as const,
          code: "OPERATION_INVALID_RESULT",
          message: "The operation batch would produce an invalid architecture.",
          path: "architecture",
          suggestion: "Review resource limits, identifiers, and graph relationships.",
        }),
      ]),
    });
  }
  return Object.freeze({
    ok: true,
    architecture: parsed.data,
    diagnostics: Object.freeze([]),
  });
}

function architectGraphOperations(
  operations: ArchitectOperation[],
  confirmation: DestructiveConfirmation,
): GraphOperation[] {
  return operations.map((operation): GraphOperation => {
    switch (operation.type) {
      case "add_resource":
        return {
          type: "add_resource",
          resource: {
            ...operation.resource,
            origin: "inferred-minimal",
            reason: operation.reason,
            approvalStatus: "not-required",
          },
        };
      case "update_resource":
        return {
          type: "update_resource",
          resourceId: operation.resourceId,
          changes: operation.changes,
        };
      case "remove_resource":
        return {
          type: "remove_resource",
          resourceId: operation.resourceId,
          confirmation,
        };
      case "add_relationship":
        return {
          type: "add_relationship",
          relationship: {
            ...operation.relationship,
            origin: "inferred-minimal",
            reason: operation.reason,
            approvalStatus: "not-required",
          },
        };
      case "remove_relationship":
        return {
          type: "remove_relationship",
          relationshipId: operation.relationshipId,
          confirmation,
        };
    }
  });
}

function parseArchitectOperations(
  architectureInput: Architecture,
  operationsInput: ArchitectOperation[],
) {
  const architecture = ArchitectureSchema.parse(architectureInput);
  const parsed = ArchitectOperationSchema.array().min(1).max(200).safeParse(
    operationsInput,
  );
  return parsed.success
    ? { ok: true as const, architecture, operations: parsed.data }
    : { ok: false as const, result: invalidOperationResult(architecture) };
}

export function validateArchitectOperations(
  architectureInput: Architecture,
  operationsInput: ArchitectOperation[],
): OperationResult {
  const parsed = parseArchitectOperations(architectureInput, operationsInput);
  if (!parsed.ok) return parsed.result;
  return applyGraphOperations(
    parsed.architecture,
    architectGraphOperations(parsed.operations, {
      confirmed: true,
      rationale: "Server-only proposal validation; no graph mutation is published.",
    }),
    "architect",
  );
}

export function applyArchitectOperations(
  architectureInput: Architecture,
  operationsInput: ArchitectOperation[],
  destructiveConfirmation?: DestructiveConfirmation,
): OperationResult {
  const parsed = parseArchitectOperations(architectureInput, operationsInput);
  if (!parsed.ok) return parsed.result;
  const destructive = parsed.operations.some((operation) =>
    operation.type === "remove_resource" ||
    operation.type === "remove_relationship"
  );
  const confirmation = DestructiveConfirmationSchema.safeParse(
    destructiveConfirmation,
  );
  if (destructive && !confirmation.success) {
    return invalidOperationResult(
      parsed.architecture,
      "ARCHITECT_DESTRUCTIVE_CONFIRMATION_REQUIRED",
      "Review and confirm the destructive architect operations before applying.",
    );
  }
  return applyGraphOperations(
    parsed.architecture,
    architectGraphOperations(
      parsed.operations,
      confirmation.success
        ? confirmation.data
        : {
            confirmed: true,
            rationale: "No destructive architect operations are present.",
          },
    ),
    "architect",
  );
}

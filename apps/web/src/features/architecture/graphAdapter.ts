import {
  ArchitectureLayoutSchema,
  type Architecture,
  type ArchitectureLayout,
  type ArchitectureResource,
} from "@architect/contracts";
import type { Edge, Node, XYPosition } from "@xyflow/react";

export type ArchitectureNodeData = Readonly<{
  resource: ArchitectureResource;
}>;

export type ArchitectureNode = Node<ArchitectureNodeData, "architecture">;
export type ArchitectureEdge = Edge<Readonly<{ reason: string }>>;

function defaultPosition(index: number): XYPosition {
  return {
    x: (index % 4) * 260,
    y: Math.floor(index / 4) * 180 + 40,
  };
}

export function toReactFlowGraph(
  architecture: Architecture,
  layout: ArchitectureLayout,
): Readonly<{
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
}> {
  const positions = new Map(
    layout.nodes.map((node) => [
      node.resourceId,
      { x: node.x, y: node.y },
    ]),
  );
  return {
    nodes: architecture.resources.map((resource, index) => ({
      id: resource.id,
      type: "architecture",
      position: positions.get(resource.id) ?? defaultPosition(index),
      data: { resource },
    })),
    edges: architecture.relationships.map((relationship) => ({
      id: relationship.id,
      source: relationship.sourceId,
      target: relationship.targetId,
      label: relationship.label ?? relationship.kind,
      data: { reason: relationship.reason },
    })),
  };
}

export function applyLayoutChange(
  layout: ArchitectureLayout,
  change: Readonly<{ id: string; position: XYPosition }>,
): ArchitectureLayout {
  const found = layout.nodes.some((node) => node.resourceId === change.id);
  return ArchitectureLayoutSchema.parse({
    ...layout,
    nodes: found
      ? layout.nodes.map((node) => node.resourceId === change.id
        ? {
            resourceId: node.resourceId,
            x: change.position.x,
            y: change.position.y,
          }
        : node)
      : [
          ...layout.nodes,
          {
            resourceId: change.id,
            x: change.position.x,
            y: change.position.y,
          },
        ],
  });
}

export function layoutFromNodes(
  revisionId: string,
  nodes: ReadonlyArray<Pick<ArchitectureNode, "id" | "position">>,
): ArchitectureLayout {
  return ArchitectureLayoutSchema.parse({
    version: "architecture-layout/v1",
    revisionId,
    nodes: nodes.map((node) => ({
      resourceId: node.id,
      x: node.position.x,
      y: node.position.y,
    })),
  });
}

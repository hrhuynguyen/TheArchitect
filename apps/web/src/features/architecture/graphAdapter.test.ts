import { defaultRequirementsProfile } from "@architect/contracts";
import { describe, expect, it } from "vitest";

import {
  applyLayoutChange,
  layoutFromNodes,
  toReactFlowGraph,
} from "./graphAdapter.js";

const architecture = {
  version: "architecture/v1" as const,
  requirements: defaultRequirementsProfile(),
  resources: [
    {
      id: "app",
      type: "Lambda" as const,
      name: "API handler",
      properties: {},
      origin: "explicit" as const,
      reason: "The source explicitly includes an application handler.",
      approvalStatus: "not-required" as const,
    },
    {
      id: "queue",
      type: "SQS" as const,
      name: "Work queue",
      properties: {},
      origin: "inferred-minimal" as const,
      reason: "A queue is required to buffer work.",
      approvalStatus: "not-required" as const,
    },
  ],
  relationships: [{
    id: "app-to-queue",
    sourceId: "app",
    targetId: "queue",
    kind: "publishes" as const,
    label: "jobs",
    origin: "explicit" as const,
    reason: "The application publishes jobs.",
    approvalStatus: "not-required" as const,
  }],
  decisions: [],
  unresolvedQuestions: [],
};

const layout = {
  version: "architecture-layout/v1" as const,
  revisionId: "revision-a",
  nodes: [{ resourceId: "app", x: 10, y: 20 }],
};

describe("React Flow graph adapter", () => {
  it("maps semantic resources and relationships without merging layout into them", () => {
    const original = structuredClone(architecture);
    const graph = toReactFlowGraph(architecture, layout);

    expect(graph.nodes).toEqual([
      expect.objectContaining({
        id: "app",
        position: { x: 10, y: 20 },
        data: expect.objectContaining({ resource: architecture.resources[0] }),
      }),
      expect.objectContaining({
        id: "queue",
        position: { x: 260, y: 40 },
      }),
    ]);
    expect(graph.edges).toEqual([expect.objectContaining({
      id: "app-to-queue",
      source: "app",
      target: "queue",
      label: "jobs",
    })]);
    expect(architecture).toEqual(original);
  });

  it("moves React Flow nodes without changing semantic resources", () => {
    const originalResources = structuredClone(architecture.resources);
    const next = applyLayoutChange(layout, {
      id: "app",
      position: { x: 40, y: 80 },
    });

    expect(next.nodes).toContainEqual({ resourceId: "app", x: 40, y: 80 });
    expect(architecture.resources).toEqual(originalResources);
    expect(layout.nodes[0]).toEqual({ resourceId: "app", x: 10, y: 20 });
  });

  it("serializes only positions from React Flow nodes", () => {
    const graph = toReactFlowGraph(architecture, layout);
    const next = layoutFromNodes("revision-a", graph.nodes.map((node, index) => ({
      ...node,
      position: { x: index * 100, y: index * 50 },
    })));

    expect(next).toEqual({
      version: "architecture-layout/v1",
      revisionId: "revision-a",
      nodes: [
        { resourceId: "app", x: 0, y: 0 },
        { resourceId: "queue", x: 100, y: 50 },
      ],
    });
  });
});

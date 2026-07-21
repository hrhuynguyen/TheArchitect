import {
  requirementsProfileSchema,
  type RequirementsProfile,
} from "@architect/contracts/requirements";
import {
  stageDecisionSchema,
  type StageDecision,
  type StageUpgradeProposal,
  type WorkloadStage,
} from "@architect/contracts/infrastructure";

const USER_SCORE: Record<RequirementsProfile["expectedUsers"], number> = {
  tiny: 0,
  small: 1,
  medium: 2,
  large: 3,
  global: 4,
};

const TRAFFIC_SCORE: Record<RequirementsProfile["traffic"], number> = {
  low: 0,
  moderate: 1,
  high: 2,
  extreme: 4,
};

const CRITICALITY_SCORE: Record<RequirementsProfile["criticality"], number> = {
  non_critical: 0,
  business_critical: 2,
  mission_critical: 4,
};

const AVAILABILITY_SCORE: Record<RequirementsProfile["availability"], number> = {
  best_effort: 0,
  high_availability: 2,
  continuous: 4,
};

const RECOVERY_SCORE: Record<RequirementsProfile["recovery"], number> = {
  flexible: 0,
  standard: 1,
  rapid: 3,
};

function scoreRequirements(requirements: RequirementsProfile): number {
  return (
    USER_SCORE[requirements.expectedUsers] +
    TRAFFIC_SCORE[requirements.traffic] +
    CRITICALITY_SCORE[requirements.criticality] +
    AVAILABILITY_SCORE[requirements.availability] +
    RECOVERY_SCORE[requirements.recovery] +
    (requirements.audience === "external" ? 1 : 0) +
    (requirements.burstiness === "bursty"
      ? 1
      : requirements.burstiness === "spiky"
        ? 2
        : 0) +
    (requirements.asyncWorkload ? 1 : 0)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stageFromScore(
  requirements: RequirementsProfile,
  score: number,
): WorkloadStage {
  if (
    requirements.availability === "continuous" ||
    (requirements.criticality === "mission_critical" &&
      requirements.recovery === "rapid")
  ) {
    return "production";
  }
  if (score <= 1) return "prototype";
  if (score <= 4) return "mvp";
  if (score <= 8) return "growth";
  return "production";
}

function confidenceFor(stage: WorkloadStage, score: number): StageDecision["confidence"] {
  if ((stage === "prototype" && score <= 1) || (stage === "production" && score >= 11)) {
    return "high";
  }
  if (stage === "mvp" && score >= 2 && score <= 3) return "high";
  if (stage === "growth" && score >= 6 && score <= 8) return "high";
  return "medium";
}

function proposalsFor(
  stage: WorkloadStage,
  requirements: RequirementsProfile,
): StageUpgradeProposal[] {
  if (stage === "prototype" || stage === "mvp") return [];

  const proposals: StageUpgradeProposal[] = [];
  if (requirements.audience === "external") {
    proposals.push({
      id: "redundant-ingress",
      title: "Add redundant ingress",
      summary: "Put a managed load balancer in front of internet-facing compute.",
      affects: ["ingress", "compute"],
    });
  }
  if (
    requirements.traffic === "high" ||
    requirements.traffic === "extreme" ||
    requirements.availability !== "best_effort" ||
    requirements.criticality !== "non_critical"
  ) {
    proposals.push({
      id: "redundant-compute",
      title: "Add redundant compute",
      summary: "Add independent compute capacity for traffic and availability needs.",
      affects: ["compute"],
    });
  }
  if (stage === "production") {
    proposals.push({
      id: "multi-zone-networking",
      title: "Use multiple availability zones",
      summary: "Distribute network and compute capacity across availability zones.",
      affects: ["network", "compute"],
    });
  }

  return proposals.sort((left, right) => compareText(left.id, right.id));
}

export function selectStage(input: RequirementsProfile): StageDecision {
  const requirements = requirementsProfileSchema.parse(input);
  const score = scoreRequirements(requirements);
  const stage = stageFromScore(requirements, score);
  const proposedUpgrades = proposalsFor(stage, requirements);
  const reasons = [
    `Deterministic workload score ${score} maps to the ${stage} stage.`,
  ];

  if (requirements.audience === "external") {
    reasons.push("External users require a deliberate ingress path.");
  }
  if (requirements.availability !== "best_effort") {
    reasons.push("Availability requirements increase topology redundancy.");
  }
  if (requirements.recovery === "rapid") {
    reasons.push("Rapid recovery requires production-grade resilience.");
  }

  return stageDecisionSchema.parse({
    version: "stage-decision/v1",
    stage,
    confidence: confidenceFor(stage, score),
    reasons,
    requiresApproval: proposedUpgrades.length > 0,
    proposedUpgrades,
  });
}

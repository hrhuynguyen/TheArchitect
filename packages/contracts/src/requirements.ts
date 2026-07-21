import { z } from "zod";

export const RequirementsProfileSchema = z
  .object({
    version: z.literal("requirements/v1"),
    audience: z.enum(["internal", "external"]),
    criticality: z.enum([
      "non_critical",
      "business_critical",
      "mission_critical",
    ]),
    expectedUsers: z.enum(["tiny", "small", "medium", "large", "global"]),
    traffic: z.enum(["low", "moderate", "high", "extreme"]),
    burstiness: z.enum(["steady", "bursty", "spiky"]),
    asyncWorkload: z.boolean(),
    availability: z.enum(["best_effort", "high_availability", "continuous"]),
    recovery: z.enum(["flexible", "standard", "rapid"]),
  })
  .strict();

export const requirementsProfileSchema = RequirementsProfileSchema;
export type RequirementsProfile = z.infer<typeof RequirementsProfileSchema>;

const SAFE_DEFAULT = {
  version: "requirements/v1",
  audience: "external",
  criticality: "non_critical",
  expectedUsers: "tiny",
  traffic: "low",
  burstiness: "steady",
  asyncWorkload: false,
  availability: "best_effort",
  recovery: "flexible",
} as const satisfies RequirementsProfile;

export function defaultRequirementsProfile(): Readonly<RequirementsProfile> {
  return Object.freeze(RequirementsProfileSchema.parse(SAFE_DEFAULT));
}

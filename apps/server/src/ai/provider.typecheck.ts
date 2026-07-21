import type { z } from "zod";
import type { ArchitectProtocol } from "./provider.js";

export type InvalidScalarArchitectProtocol = ArchitectProtocol<
  { request: string },
  // @ts-expect-error Architect output protocols require a root object schema.
  z.ZodString
>;

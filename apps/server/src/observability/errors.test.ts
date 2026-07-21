import { describe, expect, it } from "vitest";
import { PublicError } from "./errors";

describe("PublicError", () => {
  it("uses the stable public-error name and default status", () => {
    const error = new PublicError("invalid_request", "Invalid request");

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      code: "invalid_request",
      message: "Invalid request",
      name: "PublicError",
      statusCode: 400,
      details: undefined,
    });
  });

  it("preserves a custom status and details", () => {
    const details = { field: "prompt" };
    const error = new PublicError(
      "missing_prompt",
      "Prompt is required",
      422,
      details,
    );

    expect(error.statusCode).toBe(422);
    expect(error.details).toBe(details);
  });
});

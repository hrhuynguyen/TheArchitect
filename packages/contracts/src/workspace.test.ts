import { describe, expect, it } from "vitest";
import { APP_NAME, CONTRACT_VERSION } from "./index";

describe("workspace contract", () => {
  it("exposes stable product identifiers", () => {
    expect(APP_NAME).toBe("The Architect");
    expect(CONTRACT_VERSION).toBe("architect/v1");
  });
});

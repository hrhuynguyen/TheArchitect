import { describe, expect, it, vi } from "vitest";
import { databaseHealth } from "./health";

describe("databaseHealth", () => {
  it("reports database readiness after a successful probe", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ value: 1 }]);

    await expect(databaseHealth({ $queryRaw: queryRaw })).resolves.toEqual({
      ok: true,
    });
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  it("propagates a failed database probe", async () => {
    const connectionError = new Error("database unavailable");
    const queryRaw = vi.fn().mockRejectedValue(connectionError);

    await expect(databaseHealth({ $queryRaw: queryRaw })).rejects.toBe(
      connectionError,
    );
  });
});

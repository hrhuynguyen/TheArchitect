import { describe, expect, it, vi } from "vitest";
import { createRoomApi, RoomApiError } from "./api";

const validRoom = {
  id: "room-ada",
  mode: "shared" as const,
  phase: "sketch" as const,
  isOwner: true,
  participants: [{ id: "participant-ada", name: "Ada", color: "#10A37F" }],
  joinPath: "/room/room-ada",
};

describe("roomApi", () => {
  it("creates a room with credentials and validates the response contract", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(validRoom), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const api = createRoomApi(fetcher);

    await expect(
      api.create({ name: "Ada", color: "#10A37F" }, "shared"),
    ).resolves.toEqual(validRoom);
    expect(fetcher).toHaveBeenCalledWith("/api/rooms", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada", color: "#10A37F", mode: "shared" }),
    });
  });

  it("rejects successful responses that do not satisfy the room contract", async () => {
    const api = createRoomApi(
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: "room-ada" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(api.get("room-ada")).rejects.toThrow(
      "The room service returned an invalid response.",
    );
  });

  it("surfaces public non-2xx API errors", async () => {
    const api = createRoomApi(
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ code: "room_not_found", message: "Room not found" }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const error = await api.get("missing").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RoomApiError);
    expect(error).toMatchObject({
      message: "Room not found",
      code: "room_not_found",
      status: 404,
    });
  });
});

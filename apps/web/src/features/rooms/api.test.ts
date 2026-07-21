import { describe, expect, it, vi } from "vitest";
import { createRoomApi, RoomApiError } from "./api";

const validRoom = {
  id: "room-ada",
  mode: "shared" as const,
  phase: "sketch" as const,
  isOwner: true,
  currentParticipantId: "participant-ada",
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

  it("normalizes fetch rejections to a stable public network error", async () => {
    const api = createRoomApi(
      vi.fn().mockRejectedValue(new TypeError("fetch failed for private-host:3001")),
    );

    const error = await api.get("room-ada").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RoomApiError);
    expect(error).toMatchObject({
      message: "Unable to reach the room service. Check your connection and try again.",
      code: "room_network_error",
      status: 0,
    });
  });

  it("preserves an existing RoomApiError rejected by the fetch boundary", async () => {
    const existing = new RoomApiError("Known room error", 409, "known_room_error");
    const api = createRoomApi(vi.fn().mockRejectedValue(existing));

    await expect(api.get("room-ada")).rejects.toBe(existing);
  });

  it("gets the latest room summary without using a browser cache", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(validRoom), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const api = createRoomApi(fetcher);

    await expect(api.get("room-ada")).resolves.toMatchObject({ id: "room-ada" });
    expect(fetcher).toHaveBeenCalledWith("/api/rooms/room-ada", {
      cache: "no-store",
      credentials: "include",
    });
  });
});

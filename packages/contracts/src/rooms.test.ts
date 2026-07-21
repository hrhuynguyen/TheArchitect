import { describe, expect, it } from "vitest";
import { RoomSummarySchema } from "./rooms.js";

const room = {
  id: "room-1",
  mode: "shared",
  phase: "sketch",
  isOwner: false,
  participants: [
    { id: "participant-1", name: "Ada", color: "#10A37F" },
  ],
} as const;

describe("RoomSummarySchema", () => {
  it("requires an exact current participant identifier or null", () => {
    expect(
      RoomSummarySchema.parse({
        ...room,
        currentParticipantId: "participant-1",
      }).currentParticipantId,
    ).toBe("participant-1");
    expect(
      RoomSummarySchema.parse({
        ...room,
        currentParticipantId: null,
      }).currentParticipantId,
    ).toBeNull();
    expect(() => RoomSummarySchema.parse(room)).toThrow();
    expect(() =>
      RoomSummarySchema.parse({ ...room, currentParticipantId: "" }),
    ).toThrow();
  });
});

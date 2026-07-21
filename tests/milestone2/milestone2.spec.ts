import { PrismaClient } from "@prisma/client";
import {
  expect,
  test,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import * as Y from "yjs";
import {
  startMilestone2Environment,
  type Milestone2Environment,
} from "./environment.js";

const shapeLocator = ".whiteboard__canvas .tl-shape";

let environment: Milestone2Environment;

async function expectWorkspace(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "Map the system together." }),
  ).toBeVisible();
  await expect(page.locator(".whiteboard__canvas .tl-canvas")).toBeVisible();
}

async function expectCollaborators(page: Page): Promise<void> {
  const collaborators = page.getByRole("list", { name: "Live collaborators" });
  await expect(collaborators).toContainText("Ada");
  await expect(collaborators).toContainText("Grace");
}

async function seedProfile(
  context: BrowserContext,
  name: string,
): Promise<void> {
  await context.addInitScript((profile) => {
    localStorage.setItem("architect.guest-profile.v1", JSON.stringify(profile));
  }, { name, color: "#10A37F" });
}

async function openStartAs(page: Page, name: string): Promise<void> {
  await page.goto(`${environment.webUrl}/start`);
  await expect(page.getByLabel("Display name")).toHaveValue(name);
}

async function drawRectangle(page: Page, offset: number): Promise<void> {
  const canvas = page.locator(".whiteboard__canvas .tl-canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds, "tldraw canvas must have measurable bounds").not.toBeNull();
  await canvas.click({ position: { x: 80 + offset, y: 90 + offset } });
  await page.keyboard.press("r");
  await page.mouse.move(bounds!.x + 80 + offset, bounds!.y + 90 + offset);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 180 + offset, bounds!.y + 160 + offset, {
    steps: 4,
  });
  await page.mouse.up();
}

async function persistedWorkspaceReady(
  prisma: PrismaClient,
  roomId: string,
): Promise<boolean> {
  const snapshot = await prisma.yjsSnapshot.findFirst({
    where: { roomId },
    orderBy: { version: "desc" },
  });
  if (!snapshot) return false;
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, snapshot.payload);
    const shapes = [...document.getMap<unknown>("tldraw/records").values()].filter(
      (record) =>
        record !== null &&
        typeof record === "object" &&
        (record as { typeName?: unknown }).typeName === "shape",
    );
    const requirements = document
      .getMap<unknown>("requirements")
      .get("current") as { traffic?: unknown } | undefined;
    return shapes.length === 2 && requirements?.traffic === "moderate";
  } finally {
    document.destroy();
  }
}

test.beforeAll(async () => {
  environment = await startMilestone2Environment();
});

test.afterAll(async () => {
  await environment?.stop();
});

test("proves two-context consensus, one transition, and restart recovery", async ({
  browser,
}) => {
  const prisma = new PrismaClient({
    datasources: { db: { url: environment.databaseUrl } },
  });
  const adaContext = await browser.newContext();
  const graceContext = await browser.newContext();
  await Promise.all([
    seedProfile(adaContext, "Ada"),
    seedProfile(graceContext, "Grace"),
  ]);
  const ada = await adaContext.newPage();
  const grace = await graceContext.newPage();

  try {
    await openStartAs(ada, "Ada");
    await expect(
      ada.getByRole("button", { name: "Create shared room" }),
    ).toBeEnabled();
    await ada.getByRole("button", { name: "Create shared room" }).click();
    await expect(ada).toHaveURL(/\/room\/[A-Za-z0-9_-]+$/);
    const roomId = decodeURIComponent(
      new URL(ada.url()).pathname.split("/").at(-1)!,
    );
    await expectWorkspace(ada);

    await openStartAs(grace, "Grace");
    await expect(grace.getByRole("button", { name: "Join room" })).toBeEnabled();
    await grace.getByRole("button", { name: "Join room" }).click();
    await grace.getByLabel("Room ID or link").fill(roomId);
    await grace.getByRole("button", { name: "Join workspace" }).click();
    await expect(grace).toHaveURL(new RegExp(`/room/${roomId}$`));
    await expectWorkspace(grace);
    await Promise.all([expectCollaborators(ada), expectCollaborators(grace)]);

    await drawRectangle(ada, 0);
    await expect.poll(() => grace.locator(shapeLocator).count()).toBe(1);
    await drawRectangle(grace, 110);
    await expect.poll(() => ada.locator(shapeLocator).count()).toBe(2);
    await expect.poll(() => grace.locator(shapeLocator).count()).toBe(2);

    await ada.getByLabel("Traffic volume").selectOption("moderate");
    await expect(grace.getByLabel("Traffic volume")).toHaveValue("moderate");
    await expect
      .poll(() => persistedWorkspaceReady(prisma, roomId), { timeout: 20_000 })
      .toBe(true);

    await environment.restartServer();
    await Promise.all([ada.reload(), grace.reload()]);
    await Promise.all([expectWorkspace(ada), expectWorkspace(grace)]);
    await Promise.all([expectCollaborators(ada), expectCollaborators(grace)]);
    await expect.poll(() => ada.locator(shapeLocator).count()).toBe(2);
    await expect.poll(() => grace.locator(shapeLocator).count()).toBe(2);
    await expect(ada.getByLabel("Traffic volume")).toHaveValue("moderate");
    await expect(grace.getByLabel("Traffic volume")).toHaveValue("moderate");

    await ada.getByRole("button", { name: "I’m ready" }).click();
    await expect(ada.getByText("1 of 2 ready", { exact: true })).toBeVisible();
    await expect(grace.getByText("1 of 2 ready", { exact: true })).toBeVisible();
    await expect(
      ada.getByText("At least 80% of active collaborators must be ready."),
    ).toBeVisible();

    await grace.getByRole("button", { name: "I’m ready" }).click();
    const architectHeading = "Shape the system into a buildable plan.";
    await expect(
      ada.getByRole("heading", { name: architectHeading }),
    ).toBeVisible();
    await expect(
      grace.getByRole("heading", { name: architectHeading }),
    ).toBeVisible();

    await expect
      .poll(async () => {
        const room = await prisma.room.findUnique({
          where: { id: roomId },
          select: {
            phase: true,
            transitions: {
              where: { kind: "ready" },
              select: { id: true, sourceRevision: true },
            },
          },
        });
        return {
          phase: room?.phase,
          readyJobs: room?.transitions.length,
        };
      })
      .toEqual({ phase: "reconstructing", readyJobs: 1 });
    const transition = await prisma.transitionJob.findFirstOrThrow({
      where: { roomId, kind: "ready" },
      select: { sourceRevision: true },
    });
    expect(transition.sourceRevision).toBeGreaterThan(0);
    await expect(
      prisma.yjsSnapshot.findUnique({
        where: {
          roomId_version: { roomId, version: transition.sourceRevision },
        },
        select: { reason: true },
      }),
    ).resolves.toEqual({ reason: "vote_ready" });
    const phaseSnapshot = await prisma.yjsSnapshot.findFirstOrThrow({
      where: { roomId, reason: "phase_transition" },
      orderBy: { version: "asc" },
      select: { version: true },
    });
    expect(phaseSnapshot.version).toBeGreaterThan(transition.sourceRevision);
  } finally {
    await Promise.all([adaContext.close(), graceContext.close()]);
    await prisma.$disconnect();
  }
});

import { PrismaClient } from "@prisma/client";
import {
  ARCHITECTURE_CURRENT_KEY,
  ARCHITECTURE_MAP_KEY,
  WorkingArchitectureSchema,
} from "@architect/contracts";
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

async function persistedArchitecture(
  prisma: PrismaClient,
  roomId: string,
) {
  const snapshot = await prisma.yjsSnapshot.findFirstOrThrow({
    where: { roomId },
    orderBy: { version: "desc" },
    select: { payload: true, version: true },
  });
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, snapshot.payload);
    const architecture = WorkingArchitectureSchema.parse(
      document
        .getMap(ARCHITECTURE_MAP_KEY)
        .get(ARCHITECTURE_CURRENT_KEY),
    );
    return {
      revisionId: architecture.revisionId,
      resourceNames: architecture.architecture.resources.map(({ name }) => name),
      snapshotVersion: snapshot.version,
    };
  } finally {
    document.destroy();
  }
}

async function expectArchitectTurn(
  page: Page,
  responseText: string,
): Promise<void> {
  await expect(page.getByText(responseText, { exact: true })).toBeVisible();
}

async function expectQueueCount(page: Page, count: number): Promise<void> {
  await expect(
    page.locator(".architecture-node").filter({ hasText: "Orders queue" }),
  ).toHaveCount(count);
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
    const architectHeading = "Shape the buildable system.";
    await expect(
      ada.getByRole("heading", { name: architectHeading }),
    ).toBeVisible();
    await expect(
      grace.getByRole("heading", { name: architectHeading }),
    ).toBeVisible();
    await expect(ada.getByText("Sketch storage", { exact: true })).toBeVisible();
    await expect(
      ada.getByRole("heading", { name: "Revision 1" }),
    ).toBeVisible();

    await expect
      .poll(async () => {
        const room = await prisma.room.findUnique({
          where: { id: roomId },
          select: {
            phase: true,
            transitions: {
              where: { kind: "ready" },
              select: { id: true, sourceRevision: true, state: true },
            },
          },
        });
        return {
          phase: room?.phase,
          readyJobs: room?.transitions.length,
          readyState: room?.transitions[0]?.state,
        };
      })
      .toEqual({ phase: "architect", readyJobs: 1, readyState: "succeeded" });
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

    const explanationText =
      "The current architecture contains the resources and relationships shown on the shared canvas.";
    await ada.getByRole("textbox", { name: "Ask the Architect" })
      .fill("Explain this architecture.");
    await ada.getByRole("button", { name: "Ask Architect" }).click();
    await Promise.all([
      expectArchitectTurn(ada, explanationText),
      expectArchitectTurn(grace, explanationText),
    ]);
    await expect
      .poll(() => prisma.architectProposal.count({
        where: { roomId, state: "answered" },
      }))
      .toBe(1);

    const beforeProposal = await persistedArchitecture(prisma, roomId);
    const beforeRevisionCount = await prisma.architectureRevision.count({
      where: { roomId },
    });
    await grace.getByRole("textbox", { name: "Ask the Architect" })
      .fill("Add an SQS queue.");
    await grace.getByRole("button", { name: "Ask Architect" }).click();
    const proposalText = "I can add an SQS queue to buffer asynchronous work.";
    await Promise.all([
      expectArchitectTurn(ada, proposalText),
      expectArchitectTurn(grace, proposalText),
    ]);
    await Promise.all([expectQueueCount(ada, 0), expectQueueCount(grace, 0)]);
    await expect(
      ada.getByRole("heading", { name: "Revision 1" }),
    ).toBeVisible();
    await expect(
      grace.getByRole("heading", { name: "Revision 1" }),
    ).toBeVisible();
    await expect
      .poll(() => prisma.architectProposal.count({
        where: { roomId, state: "proposal_ready" },
      }))
      .toBe(1);
    expect(await persistedArchitecture(prisma, roomId)).toEqual(beforeProposal);
    expect(await prisma.architectureRevision.count({ where: { roomId } }))
      .toBe(beforeRevisionCount);

    await grace.getByRole("button", { name: "Review patch" }).click();
    const reviewDialog = grace.getByRole("dialog", {
      name: "Review Architect patch",
    });
    await expect(reviewDialog).toContainText("Add SQS “Orders queue”");
    await reviewDialog
      .getByLabel("Review rationale")
      .fill("Buffer asynchronous orders across transient worker failures.");
    await reviewDialog.getByRole("button", { name: "Apply patch" }).click();

    await Promise.all([expectQueueCount(ada, 1), expectQueueCount(grace, 1)]);
    await Promise.all([
      expect(
        ada.getByRole("heading", { name: "Revision 2" }),
      ).toBeVisible(),
      expect(
        grace.getByRole("heading", { name: "Revision 2" }),
      ).toBeVisible(),
    ]);
    await expect
      .poll(async () => {
        const [applied, revisions, revisionEvents, proposalEvents] =
          await Promise.all([
            prisma.architectProposal.count({
              where: { roomId, state: "applied" },
            }),
            prisma.architectureRevision.count({ where: { roomId } }),
            prisma.historyEvent.count({
              where: { roomId, kind: "architecture_revision_saved" },
            }),
            prisma.historyEvent.count({
              where: { roomId, kind: "architect_proposal_applied" },
            }),
          ]);
        return { applied, proposalEvents, revisionEvents, revisions };
      })
      .toEqual({
        applied: 1,
        proposalEvents: 1,
        revisionEvents: 1,
        revisions: 2,
      });
    const afterApply = await persistedArchitecture(prisma, roomId);
    expect(afterApply.revisionId).not.toBe(beforeProposal.revisionId);
    expect(afterApply.resourceNames).toEqual(
      expect.arrayContaining(["Sketch storage", "Orders queue"]),
    );
    expect(afterApply.snapshotVersion).toBeGreaterThan(
      beforeProposal.snapshotVersion,
    );

    await environment.restartServer();
    await Promise.all([ada.reload(), grace.reload()]);
    await Promise.all([
      expect(
        ada.getByRole("heading", { name: architectHeading }),
      ).toBeVisible(),
      expect(
        grace.getByRole("heading", { name: architectHeading }),
      ).toBeVisible(),
    ]);
    await Promise.all([expectQueueCount(ada, 1), expectQueueCount(grace, 1)]);
    await Promise.all([
      expect(
        ada.getByRole("heading", { name: "Revision 2" }),
      ).toBeVisible(),
      expect(
        grace.getByRole("heading", { name: "Revision 2" }),
      ).toBeVisible(),
      expectArchitectTurn(ada, explanationText),
      expectArchitectTurn(grace, explanationText),
      expectArchitectTurn(ada, proposalText),
      expectArchitectTurn(grace, proposalText),
    ]);
    const afterRestart = await persistedArchitecture(prisma, roomId);
    expect(afterRestart).toMatchObject({
      revisionId: afterApply.revisionId,
      resourceNames: afterApply.resourceNames,
    });
    expect(afterRestart.snapshotVersion).toBeGreaterThanOrEqual(
      afterApply.snapshotVersion,
    );
    await expect(
      prisma.architectProposal.groupBy({
        by: ["state"],
        where: { roomId },
        _count: { _all: true },
        orderBy: { state: "asc" },
      }),
    ).resolves.toEqual([
      { _count: { _all: 1 }, state: "answered" },
      { _count: { _all: 1 }, state: "applied" },
    ]);
  } finally {
    await Promise.all([adaContext.close(), graceContext.close()]);
    await prisma.$disconnect();
  }
});

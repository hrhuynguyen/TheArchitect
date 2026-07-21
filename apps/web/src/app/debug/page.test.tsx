import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const notFound = vi.hoisted(() => vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
}));

vi.mock("next/navigation", () => ({ notFound }));
vi.mock("../../features/debug/DebugBench", () => ({
  DebugBench: () => <main>Diagnostic bench</main>,
}));

import DebugPage from "./page";

afterEach(() => {
  vi.unstubAllEnvs();
  notFound.mockClear();
});

describe("debug page gate", () => {
  it.each([
    [undefined, "development"],
    ["false", "test"],
    ["true", "production"],
  ])("is absent for ENABLE_DEBUG_ROUTES=%j NODE_ENV=%s", (enabled, nodeEnv) => {
    vi.stubEnv("ENABLE_DEBUG_ROUTES", enabled ?? "");
    if (enabled === undefined) delete process.env.ENABLE_DEBUG_ROUTES;
    vi.stubEnv("NODE_ENV", nodeEnv);
    expect(() => renderToStaticMarkup(createElement(DebugPage))).toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(notFound).toHaveBeenCalledOnce();
  });

  it("renders only when explicitly enabled outside production", () => {
    vi.stubEnv("ENABLE_DEBUG_ROUTES", "true");
    vi.stubEnv("NODE_ENV", "development");
    expect(renderToStaticMarkup(createElement(DebugPage))).toContain(
      "Diagnostic bench",
    );
    expect(notFound).not.toHaveBeenCalled();
  });
});

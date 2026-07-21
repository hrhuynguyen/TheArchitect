import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import StartPage from "./page";

describe("start page", () => {
  it("states that solo rooms cannot accept collaborators", () => {
    const markup = renderToStaticMarkup(createElement(StartPage));

    expect(markup).toContain("Solo rooms stay private and cannot accept collaborators.");
    expect(markup).not.toContain("share later");
  });
});

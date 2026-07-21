import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "./page";

describe("home page", () => {
  it("renders the product name", () => {
    const markup = renderToStaticMarkup(createElement(Home));

    expect(markup).toContain("The Architect");
  });
});

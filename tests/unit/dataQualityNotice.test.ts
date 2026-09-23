// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DataQualityNotice } from "../../src/components/DataQualityNotice";

afterEach(cleanup);

describe("DataQualityNotice", () => {
  it("renders nothing for a fully real-data proposal", () => {
    const { container } = render(
      createElement(DataQualityNotice, { quality: { syntheticBarShare: 0, seededExperienceShare: 0, simulatedOrderBook: true } })
    );
    expect(container.textContent).toBe("");
  });

  it("warns about generated prices and seeded memory with their shares", () => {
    const { container } = render(
      createElement(DataQualityNotice, { quality: { syntheticBarShare: 0.75, seededExperienceShare: 0.4, simulatedOrderBook: true } })
    );
    expect(container.textContent).toMatch(/75% of the price history/);
    expect(container.textContent).toMatch(/Autopilot and live orders skip it/);
    expect(container.textContent).toMatch(/40% of the similar past trades/);
  });
});

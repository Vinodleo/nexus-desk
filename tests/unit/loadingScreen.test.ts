// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The opening screen: dots fly together into an N while the desk opens; when
// it's ready, the N becomes the app's icon and the screen fades to the app.

const auth = { currentUser: null as { email: string } | null, loading: true };
vi.mock("../../src/context/AuthContext", () => ({ useAuth: () => auth }));
vi.mock("../../src/components/LoginScreen", () => ({ LoginScreen: () => "the login screen" }));
vi.mock("../../src/shared/owner", () => ({ isOwner: (email?: string) => email === "owner@example.com" }));

const { LoadingScreen, N_DOTS, FINALE_EARLIEST_MS, FINALE_MS, LEAVE_MS, DOT_SHRINK_MS, DOT_RIPPLE_MS, LOGO_AT_MS } = await import(
  "../../src/components/LoadingScreen"
);
const { AuthGuard } = await import("../../src/AuthGuard");

const reducedMotion = (on: boolean) =>
  Object.defineProperty(window, "matchMedia", { configurable: true, value: (q: string) => ({ matches: on && q.includes("reduce"), addEventListener() {}, removeEventListener() {} }) });

beforeEach(() => {
  vi.useFakeTimers();
  reducedMotion(false);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const tile = () => screen.getByTestId("loading-tile");
const dots = () => screen.getAllByTestId("n-dot");

describe("the opening screen", () => {
  it("draws the N with dots in pen order: up the left, down the diagonal, up the right", () => {
    expect(N_DOTS).toHaveLength(22);
    expect(N_DOTS[0]).toEqual([0, 126]);
    expect(N_DOTS[7]).toEqual([0, 0]);
    expect(N_DOTS[14]).toEqual([90, 126]);
    expect(N_DOTS[21]).toEqual([90, 0]);
    // The diagonal runs from the top left to the bottom right.
    expect(N_DOTS.slice(8, 14).every(([x, y], i, d) => i === 0 || (x > d[i - 1][0] && y > d[i - 1][1]))).toBe(true);
  });

  it("scatters the dots, then flies them into the N while the desk opens", () => {
    render(createElement(LoadingScreen));
    expect(screen.getByRole("status").textContent).toContain("Opening the desk…");
    expect(dots()).toHaveLength(22);
    expect(dots().every((d) => d.style.transform.startsWith("translate("))).toBe(true);
    expect(tile().className).toContain("scale-0");
    act(() => vi.advanceTimersByTime(300));
    expect(dots().every((d) => d.style.transform === "none")).toBe(true);
    // One after another, in pen order.
    expect(dots()[1].style.transition).toContain("20ms");
    // Still opening: no ending until it's ready.
    act(() => vi.advanceTimersByTime(5000));
    expect(tile().className).toContain("scale-0");
  });

  it("when ready, grows the icon under the N once the dots have landed, then fades to the app", () => {
    const onDone = vi.fn();
    const { rerender } = render(createElement(LoadingScreen, { onDone }));
    act(() => vi.advanceTimersByTime(300));
    rerender(createElement(LoadingScreen, { ready: true, onDone }));
    // Not before the dots have (nearly) all landed.
    act(() => vi.advanceTimersByTime(FINALE_EARLIEST_MS - 300 - 50));
    expect(tile().className).toContain("scale-0");
    act(() => vi.advanceTimersByTime(60));
    expect(tile().className).toContain("scale-100");
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe("Ready");
    // The dots give way to the lettered N.
    expect(screen.getAllByTestId("n-dot-face").every((d) => d.style.transform === "scale(0)" && d.style.opacity === "0")).toBe(true);
    expect(tile().textContent).toBe("N");
    act(() => vi.advanceTimersByTime(FINALE_MS));
    expect(screen.getByRole("status").className).toContain("opacity-0");
    expect(onDone).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(LEAVE_MS));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("shows no dots on the logo: they shrink away under the growing tile before the N appears", () => {
    const { rerender } = render(createElement(LoadingScreen));
    act(() => vi.advanceTimersByTime(300));
    rerender(createElement(LoadingScreen, { ready: true }));
    act(() => vi.advanceTimersByTime(FINALE_EARLIEST_MS));
    const faces = screen.getAllByTestId("n-dot-face");
    // Each shrinks to nothing, one after another in pen order, all gone before the N shows.
    expect(faces.every((d) => d.style.transform === "scale(0)" && d.style.opacity === "0")).toBe(true);
    expect(faces[21].style.transition).toContain(`${DOT_SHRINK_MS}ms ease-in ${21 * DOT_RIPPLE_MS}ms`);
    expect((N_DOTS.length - 1) * DOT_RIPPLE_MS + DOT_SHRINK_MS).toBeLessThanOrEqual(LOGO_AT_MS);
    expect(screen.getByTestId("loading-logo").style.transitionDelay).toBe(`${LOGO_AT_MS}ms`);
    // Nor do they keep a colour of their own on the tile.
    expect(faces.every((d) => d.className.includes("bg-accent"))).toBe(true);
    // The tile is drawn over every dot, so none shows through as it grows.
    expect(dots().every((d) => d.compareDocumentPosition(tile()) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it("with reduced motion, shows the icon still and goes straight to the app when ready", () => {
    reducedMotion(true);
    const onDone = vi.fn();
    const { rerender } = render(createElement(LoadingScreen, { onDone }));
    expect(screen.queryAllByTestId("n-dot")).toHaveLength(0);
    expect(tile().className).toContain("scale-100");
    rerender(createElement(LoadingScreen, { ready: true, onDone }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

// The ending's steps, each in its own act so each step's timers are set before the next.
const playEnding = () => {
  act(() => vi.advanceTimersByTime(FINALE_EARLIEST_MS));
  act(() => vi.advanceTimersByTime(FINALE_MS));
  act(() => vi.advanceTimersByTime(LEAVE_MS));
};

describe("opening the desk", () => {
  it("loads the desk under the opening screen, which stays until its ending has played", () => {
    auth.loading = true;
    auth.currentUser = null;
    const app = () => createElement(AuthGuard, null, "THE APP");
    const { container, rerender } = render(app());
    expect(container.textContent).not.toContain("THE APP");
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => vi.advanceTimersByTime(400));
    auth.loading = false;
    auth.currentUser = { email: "owner@example.com" };
    rerender(app());
    // The desk starts underneath at once; the screen plays its ending over it.
    expect(container.textContent).toContain("THE APP");
    expect(screen.getByRole("status")).toBeTruthy();
    playEnding();
    expect(screen.queryByRole("status")).toBeNull();
    expect(container.textContent).toBe("THE APP");
  });

  it("shows the login screen after the ending for anyone but the owner", () => {
    auth.loading = false;
    auth.currentUser = { email: "someone@example.com" };
    const { container } = render(createElement(AuthGuard, null, "THE APP"));
    playEnding();
    expect(container.textContent).toBe("the login screen");
  });
});

// A look-only account (server/auth.ts, VIEWER_EMAILS) changes nothing on the
// owner's desk, but its own IPO alerts are its own: its phone's pop-ups, its
// Telegram link and its "I got shares". These routes act for the account
// itself (its own uid), on the server and through the app's request holdback.

export const VIEWER_OWN_ROUTES = ["/api/push", "/api/telegram", "/api/ipos"];

/** A route a look-only account uses as itself: its own alerts and IPOs. */
export function isViewerOwnRoute(url: string): boolean {
  const route = url.split("?")[0];
  return VIEWER_OWN_ROUTES.some((p) => route === p || route.startsWith(`${p}/`));
}

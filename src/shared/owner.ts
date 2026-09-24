// The one account allowed into the desk. The server enforces its own list
// (ALLOWED_EMAILS); this only decides what the browser shows.
export const OWNER_EMAIL = "vinoduppar007@gmail.com";

export function isOwner(email: string | null | undefined): boolean {
  return (email ?? "").toLowerCase() === OWNER_EMAIL;
}

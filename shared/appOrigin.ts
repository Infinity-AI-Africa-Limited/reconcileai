/**
 * The origin this platform advertises in links it SENDS.
 *
 * One constant, because two copies of a production URL drift. `APP_URL` is the
 * real source in every deployment — Railway sets it, both on-prem env templates
 * set it, and docker-compose defaults it — so this literal is a safety net for a
 * configuration slip, never the normal path.
 *
 * It exists so that a missing `APP_URL` can never mean "use whatever origin the
 * caller supplied": an emailed sign-in link carries a valid token, and the
 * recipient cannot tell a wrong host from a right one.
 */
export const DEFAULT_APP_ORIGIN = "https://www.reconcileaiafrica.com";

/** Strip a trailing slash so two spellings of one origin compare equal. */
export function normalizeOrigin(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

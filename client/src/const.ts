export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

// The login destination. Manus OAuth has been replaced with email/magic-link
// authentication, so this is the in-app sign-in page (see pages/Login.tsx).
// Kept as a function so all existing call sites continue to work unchanged.
export const getLoginUrl = () => "/login";

const LOCAL_API = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/;

// Picks the API base URL at build time, failing closed: only a Vercel production build, or a
// non-Vercel build aimed at a local API, gets an API. Every other build (Vercel previews, or a
// Vercel build whose VERCEL_ENV is missing) gets "", which turns API calls off.
export function resolveApiUrl({ vercelEnv, apiUrl }) {
  if (vercelEnv === "production") return (apiUrl ?? "").replace(/\/$/, "");
  const localUrl = apiUrl ?? "http://localhost:3000";
  if (vercelEnv === undefined && LOCAL_API.test(localUrl)) return localUrl.replace(/\/$/, "");
  return "";
}

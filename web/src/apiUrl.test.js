import { describe, expect, it } from "vitest";
import { resolveApiUrl } from "./apiUrl.js";

const PROD = "https://ledgerproof-api.vercel.app";

describe("resolveApiUrl", () => {
  it("THREAT preview writes to production: a Vercel preview build ignores the production VITE_API_URL", () => {
    expect(resolveApiUrl({ vercelEnv: "preview", apiUrl: PROD })).toBe("");
  });

  it("THREAT preview writes to production: a build without VERCEL_ENV never gets a remote API", () => {
    expect(resolveApiUrl({ apiUrl: PROD })).toBe("");
  });

  it("a Vercel production build uses VITE_API_URL without a trailing slash", () => {
    expect(resolveApiUrl({ vercelEnv: "production", apiUrl: `${PROD}/` })).toBe(PROD);
  });

  it("a local build uses a local VITE_API_URL, or the local default", () => {
    expect(resolveApiUrl({ apiUrl: "http://127.0.0.1:3000/" })).toBe("http://127.0.0.1:3000");
    expect(resolveApiUrl({})).toBe("http://localhost:3000");
  });
});

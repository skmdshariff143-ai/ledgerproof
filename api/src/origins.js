// Turns the ALLOWED_ORIGINS setting into a list of exact browser origins.
// A typo must stop the server at startup: a silent "allows nothing" is hard to debug, and
// "null" would let sandboxed iframes and local files read answers.
export function parseAllowedOrigins(text = "") {
  return text
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      let canonical = null;
      try {
        canonical = new URL(origin).origin;
      } catch {
        // not a URL at all; rejected below
      }
      if (origin === "null" || canonical !== origin) {
        throw new Error(`ALLOWED_ORIGINS entry "${origin}" must be an exact origin such as https://example.com (no path, no trailing slash, not "*" or "null")`);
      }
      return origin;
    });
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAllowedOrigins } from "../src/origins.js";

test("origin config: exact origins are accepted, whitespace and empty entries are ignored", () => {
  assert.deepEqual(parseAllowedOrigins(" http://localhost:5173 , https://ledgerproof.example.com ,"), [
    "http://localhost:5173",
    "https://ledgerproof.example.com",
  ]);
  assert.deepEqual(parseAllowedOrigins(""), []);
  assert.deepEqual(parseAllowedOrigins(undefined), []);
});

test("THREAT origin config: null, wildcard, trailing slash, paths and non-URLs stop the server at startup", () => {
  for (const bad of ["null", "*", "http://a.example/", "https://a.example/app", "localhost:5173", "not a url", "file:///etc/passwd"]) {
    assert.throws(() => parseAllowedOrigins(`http://ok.example,${bad}`), /ALLOWED_ORIGINS entry/, `"${bad}" must be refused`);
  }
});

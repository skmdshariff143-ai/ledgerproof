import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

// Addresses and storage keys keep the technical name `ledgerproof`; only the words people read must say Balance Vault.
const withoutIdentifiers = (text) => text.replace(/https?:\/\/\S+/g, "").replace(/ledgerproof[.\w-]*/g, "");

describe("product name", () => {
  const shown = {
    "index.html (title, description, Open Graph)": read("../index.html"),
    "404.html": read("../public/404.html"),
    "App.jsx (header)": read("./App.jsx"),
    "Login.jsx (sign-in heading)": read("./views/Login.jsx"),
  };

  for (const [where, text] of Object.entries(shown)) {
    it(`${where} says Balance Vault and never LedgerProof`, () => {
      expect(text).toContain("Balance Vault");
      expect(withoutIdentifiers(text)).not.toMatch(/ledger[ -]?proof|ledger[ -]?vault/i);
    });
  }
});

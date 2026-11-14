import { describe, expect, it } from "vitest";
import { fingerprint, isAmbiguous, keyFor } from "./idempotency.js";

const transfer = { path: "/api/transactions/transfer", body: { toAccountNumber: "LP0000000002", amountPaise: 125 } };

describe("isAmbiguous", () => {
  it("THREAT lost response: a network failure with no success has an unknown outcome", () => {
    expect(isAmbiguous([{ ok: false, status: 0, code: "NETWORK" }])).toBe(true);
  });
  it("a server error has an unknown outcome", () => {
    expect(isAmbiguous([{ ok: false, status: 503, code: "INTERNAL" }])).toBe(true);
  });
  it("a refusal (4xx), a success and a turned-off preview are not ambiguous", () => {
    expect(isAmbiguous([{ ok: false, status: 409, code: "INSUFFICIENT_FUNDS" }])).toBe(false);
    expect(isAmbiguous([{ ok: true, status: 201 }])).toBe(false);
    expect(isAmbiguous([{ ok: false, status: 0, code: "PREVIEW_API_DISABLED" }])).toBe(false);
  });
  it("one success among two attempts settles the outcome", () => {
    expect(isAmbiguous([{ ok: true, status: 201 }, { ok: false, status: 0, code: "NETWORK" }])).toBe(false);
  });
});

describe("keyFor", () => {
  const pending = { fingerprint: fingerprint(transfer), key: "key-of-the-lost-attempt" };

  it("THREAT lost response: retrying the identical request reuses the key of the unanswered attempt", () => {
    expect(keyFor(pending, { ...transfer, body: { ...transfer.body } }, "fresh-key")).toBe("key-of-the-lost-attempt");
  });
  it("a changed amount or recipient is a different payment and gets the fresh key", () => {
    expect(keyFor(pending, { ...transfer, body: { ...transfer.body, amountPaise: 126 } }, "fresh-key")).toBe("fresh-key");
    expect(keyFor(pending, { ...transfer, body: { ...transfer.body, toAccountNumber: "LP0000000003" } }, "fresh-key")).toBe("fresh-key");
  });
  it("with nothing pending the fresh key is used", () => {
    expect(keyFor(null, transfer, "fresh-key")).toBe("fresh-key");
  });
});

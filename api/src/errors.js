// Errors carrying one of these codes become JSON responses with this HTTP status.
// Anything else is a 500 with a generic message, so SQL and stack traces never leak.
export const HTTP_STATUS = {
  INVALID_INPUT: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  KYC_PENDING: 403,
  NOT_FOUND: 404,
  ACCOUNT_NOT_FOUND: 404,
  USER_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  ALREADY_BOOTSTRAPPED: 409,
  USER_EXISTS: 409,
  INSUFFICIENT_FUNDS: 422,
  ACCOUNT_FROZEN: 422,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A lowercase UUID string. Not just UUID.test(): an array of one id turns into that id as text and would pass.
export const isUuid = (value) => typeof value === "string" && UUID.test(value);

export function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

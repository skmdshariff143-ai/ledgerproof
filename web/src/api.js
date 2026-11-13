// Set at build time by vite.config.js (see apiUrl.js); "" means this build has no API it may call.
const API_URL = __API_URL__;
export const API_DISABLED = API_URL === "";

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Every API answer is JSON; failures look like { error: { code, message } }.
// `replayed` is true when the server answered from an earlier request with the same Idempotency-Key.
export async function request(method, path, { token, body, idempotencyKey } = {}) {
  if (API_DISABLED) {
    throw new ApiError(0, "PREVIEW_API_DISABLED", "This preview has no isolated API, so sign-in and money actions are turned off.");
  }
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  let response;
  try {
    response = await fetch(API_URL + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "NETWORK", "Cannot reach the server. Is the API running?");
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON body (for example from a proxy) is reported through the generic message below.
  }
  if (!response.ok) {
    throw new ApiError(response.status, data?.error?.code ?? "UNKNOWN", data?.error?.message ?? `Request failed (${response.status})`);
  }
  return { data, status: response.status, replayed: response.headers.get("Idempotent-Replayed") === "true" };
}

import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { audit } from "./audit.js";
import { fail, isUuid } from "./errors.js";
import { hashPassword, verifyPassword } from "./password.js";

const TOKEN_LIFETIME = "1h";
// Unknown emails are checked against this hash so they take as long as a wrong password.
const DUMMY_HASH = await hashPassword(randomBytes(16).toString("hex"));

// The token carries only the user id. Role is read from the database on every request.
export async function login(pool, secret, { email, password }, ip) {
  if (typeof email !== "string" || typeof password !== "string") {
    throw fail("INVALID_INPUT", "email and password are required");
  }
  const { rows } = await pool.query("SELECT id, role, password_hash FROM users WHERE email = $1", [email.toLowerCase()]);
  const user = rows[0];
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) {
    await audit(pool, { actor: null, action: "login", ip, details: { email }, outcome: "denied" });
    throw fail("UNAUTHENTICATED", "invalid email or password");
  }
  await audit(pool, { actor: user, action: "login", ip, outcome: "success" });
  return jwt.sign({}, secret, { algorithm: "HS256", subject: user.id, expiresIn: TOKEN_LIFETIME });
}

// Sets req.user = { id, email, role } from a verified token plus a fresh database lookup.
export function authenticate(pool, secret) {
  return async (req, res, next) => {
    const [scheme, token] = (req.get("Authorization") ?? "").split(" ");
    let userId;
    try {
      if (scheme !== "Bearer" || !token) throw new Error("missing token");
      userId = jwt.verify(token, secret, { algorithms: ["HS256"] }).sub;
    } catch {
      throw fail("UNAUTHENTICATED", "a valid bearer token is required");
    }
    if (!isUuid(userId)) throw fail("UNAUTHENTICATED", "a valid bearer token is required");
    const { rows } = await pool.query("SELECT id, email, role FROM users WHERE id = $1", [userId]);
    if (rows.length === 0) throw fail("UNAUTHENTICATED", "a valid bearer token is required");
    req.user = rows[0];
    next();
  };
}

// Records the refusal in its own transaction, then rejects the request with 403.
export async function deny(pool, req, action, target) {
  await audit(pool, { actor: req.user, action, target, ip: req.ip, outcome: "denied" });
  throw fail("FORBIDDEN", "you are not allowed to do this");
}

export function allowRoles(pool, roles) {
  return async (req, res, next) => {
    if (!roles.includes(req.user.role)) await deny(pool, req, `${req.method} ${req.route.path}`, req.originalUrl);
    next();
  };
}

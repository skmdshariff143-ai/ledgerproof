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
    const { rows } = await pool.query("SELECT id, email, role, status FROM users WHERE id = $1", [userId]);
    if (rows.length === 0) throw fail("UNAUTHENTICATED", "a valid bearer token is required");
    const row = rows[0];
    req.user = {
      id: row.id,
      email: row.email,
      role: row.role.toLowerCase(),
      status: row.status,
    };
    next();
  };
}

// Records the refusal in its own transaction, then rejects the request with 403.
export async function deny(pool, req, action, target) {
  await audit(pool, { actor: req.user, action, target, ip: req.ip, outcome: "denied" });
  throw fail("FORBIDDEN", "you are not allowed to do this");
}

export function allowRoles(pool, roles) {
  const normalized = roles.map((r) => r.toLowerCase());
  return async (req, res, next) => {
    if (!normalized.includes(req.user.role.toLowerCase())) {
      await deny(pool, req, `${req.method} ${req.route.path}`, req.originalUrl);
    }
    next();
  };
}

// Registers a new account_holder in PENDING_KYC status with a 0-balance PENDING_KYC account.
// Never trusts role or status claims from the request body.
export async function registerUser(pool, secret, { email, password }, ip) {
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw fail("INVALID_INPUT", "a valid email is required");
  }
  if (typeof password !== "string" || password.length < 8) {
    throw fail("INVALID_INPUT", "password must be at least 8 characters");
  }
  const cleanEmail = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT id FROM users WHERE email = $1", [cleanEmail]);
    if (existing.rows.length > 0) throw fail("USER_EXISTS", "an account with this email already exists");
    const userRes = await client.query(
      "INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, 'account_holder', 'PENDING_KYC') RETURNING id, email, role, status, created_at",
      [cleanEmail, passwordHash],
    );
    const user = userRes.rows[0];
    const accRes = await client.query(
      "INSERT INTO accounts (account_type, owner_id, status, currency) VALUES ('user_checking', $1, 'PENDING_KYC', 'INR') RETURNING id, account_number, status, balance_paise::text AS balance_paise",
      [user.id],
    );
    await audit(client, {
      actor: user,
      action: "USER_REGISTERED",
      targetType: "user",
      target: `user:${user.id}`,
      ip,
      details: { email: user.email, accountId: accRes.rows[0].id, status: "PENDING_KYC" },
      outcome: "success",
    });
    await client.query("COMMIT");
    const token = jwt.sign({}, secret, { algorithm: "HS256", subject: user.id, expiresIn: TOKEN_LIFETIME });
    return { token, user, account: accRes.rows[0] };
  } catch (err) {
    broken = await client.query("ROLLBACK").then(() => false, () => true);
    throw err;
  } finally {
    client.release(broken);
  }
}

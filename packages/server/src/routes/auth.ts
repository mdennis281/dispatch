import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { AuthFailure, REFRESH_COOKIE, type RequestIdentity } from "../services/auth.js";

function bearer(req: FastifyRequest): string | undefined {
  const value = req.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

function cookie(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq >= 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return undefined;
}

function secureAttribute(req: FastifyRequest): string {
  // Installed Dispatch is HTTP on loopback/LAN by default. TLS deployments
  // still receive Secure when Fastify sees HTTPS directly or via a trusted proxy.
  return req.protocol === "https" ? "; Secure" : "";
}
function setRefresh(req: FastifyRequest, reply: FastifyReply, value: string): void {
  reply.header("set-cookie", `${REFRESH_COOKIE}=${encodeURIComponent(value)}; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=${90 * 24 * 60 * 60}${secureAttribute(req)}`);
}
function clearRefresh(req: FastifyRequest, reply: FastifyReply): void {
  reply.header("set-cookie", `${REFRESH_COOKIE}=; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=0${secureAttribute(req)}`);
}
function meta(req: FastifyRequest) {
  return { ua: req.headers["user-agent"] ?? "", ip: req.ip };
}
function identity(req: FastifyRequest): RequestIdentity {
  if (!req.authIdentity) throw new AuthFailure(401, "Authentication required.");
  return req.authIdentity;
}
function sessionRequest(req: FastifyRequest): void {
  // SameSite=Strict is the primary CSRF boundary. Requiring a non-simple custom
  // header as well prevents a cross-site form from reaching cookie endpoints.
  if (req.headers["x-dispatch-session"] !== "refresh") throw new AuthFailure(403, "Invalid session request.");
}

export function registerAuthRoutes(app: FastifyInstance): void {
  const auth = app.auth;
  const run = <T>(fn: () => Promise<T>, reply: FastifyReply): Promise<T | FastifyReply> =>
    fn().catch((error: unknown) => {
      if (error instanceof AuthFailure) return reply.code(error.status).send({ error: error.message });
      app.log.error(error);
      return reply.code(400).send({ error: "Unable to complete authentication request." });
    });

  app.get("/api/auth/status", (req, reply) => run(() => auth.status(bearer(req)), reply));
  app.post("/api/auth/first-run/dismiss", (_req, reply) => run(async () => {
    await auth.dismissFirstRun(); return { ok: true };
  }, reply));

  app.post("/api/auth/bootstrap", (req, reply) => run(async () => {
    sessionRequest(req);
    const result = await auth.bootstrap(req.body as Parameters<typeof auth.bootstrap>[0], meta(req));
    setRefresh(req, reply, result.refreshToken); return result.session;
  }, reply));
  app.post("/api/auth/login", (req, reply) => run(async () => {
    sessionRequest(req);
    const result = await auth.login(req.body as Parameters<typeof auth.login>[0], meta(req));
    setRefresh(req, reply, result.refreshToken); return result.session;
  }, reply));
  app.post("/api/auth/enable", (req, reply) => run(async () => {
    sessionRequest(req);
    const result = await auth.enableWithPassword(req.body as Parameters<typeof auth.enableWithPassword>[0], meta(req));
    setRefresh(req, reply, result.refreshToken); return result.session;
  }, reply));
  app.post("/api/auth/refresh", (req, reply) => run(async () => {
    sessionRequest(req);
    const result = await auth.refresh(cookie(req, REFRESH_COOKIE), meta(req));
    setRefresh(req, reply, result.refreshToken); return result.session;
  }, reply));
  app.post("/api/auth/setup/redeem", (req, reply) => run(async () => {
    sessionRequest(req);
    const result = await auth.redeemSetupCode(req.body as Parameters<typeof auth.redeemSetupCode>[0], meta(req));
    setRefresh(req, reply, result.refreshToken); return result.session;
  }, reply));
  app.post("/api/auth/passkeys/login/options", (req, reply) => run(() => auth.authenticationOptions(meta(req)), reply));
  app.post("/api/auth/passkeys/login/verify", (req, reply) => run(async () => {
    sessionRequest(req);
    const result = await auth.verifyAuthentication(req.body as { id: string; response: AuthenticationResponseJSON }, meta(req));
    setRefresh(req, reply, result.refreshToken); return result.session;
  }, reply));

  app.post("/api/auth/logout", (req, reply) => run(async () => {
    sessionRequest(req); await auth.logout(identity(req).sessionId); clearRefresh(req, reply); return { ok: true };
  }, reply));
  app.post("/api/auth/ws-ticket", (req, reply) => run(async () => ({ ticket: await auth.wsTicket(identity(req)) }), reply));
  app.get("/api/auth/security", (req, reply) => run(() => auth.security(identity(req)), reply));
  app.get("/api/auth/users", (req, reply) => run(() => auth.listUsers(identity(req)), reply));
  app.put("/api/auth/webauthn", (req, reply) => run(() => auth.updateWebAuthnSettings(
    identity(req), req.body as { canonicalUrl: string; rpId?: string },
  ), reply));
  app.post("/api/auth/setup-codes", (req, reply) => run(() => auth.createSetupCode(identity(req)), reply));
  app.post("/api/auth/password", (req, reply) => run(async () => {
    await auth.updatePassword(identity(req), req.body as { currentPassword: string; password: string }); return { ok: true };
  }, reply));
  app.post("/api/auth/totp/begin", (req, reply) => run(() => auth.beginTotp(identity(req)), reply));
  app.post("/api/auth/totp/confirm", (req, reply) => run(async () => {
    await auth.confirmTotp(identity(req), (req.body as { code?: string })?.code ?? ""); return { ok: true };
  }, reply));
  app.delete("/api/auth/totp", (req, reply) => run(async () => {
    await auth.disableTotp(identity(req), (req.body as { password?: string })?.password ?? ""); return { ok: true };
  }, reply));
  app.post("/api/auth/passkeys/register/options", (req, reply) => run(() => auth.registrationOptions(identity(req)), reply));
  app.post("/api/auth/passkeys/register/verify", (req, reply) => run(async () => {
    const body = req.body as { response: RegistrationResponseJSON; name?: string };
    await auth.verifyRegistration(identity(req), body.response, body.name); return { ok: true };
  }, reply));
  app.delete("/api/auth/passkeys/:id", (req, reply) => run(async () => {
    await auth.removePasskey(identity(req), (req.params as { id: string }).id); return { ok: true };
  }, reply));
  app.delete("/api/auth/sessions/:id", (req, reply) => run(async () => {
    await auth.revokeSession(identity(req), (req.params as { id: string }).id); return { ok: true };
  }, reply));
  app.post("/api/auth/users/:id/reset", (req, reply) => run(async () => {
    await auth.ownerResetUser(identity(req), (req.params as { id: string }).id, (req.body as { password?: string })?.password ?? ""); return { ok: true };
  }, reply));
  app.delete("/api/auth/users/:id", (req, reply) => run(async () => {
    await auth.ownerDeleteUser(identity(req), (req.params as { id: string }).id); return { ok: true };
  }, reply));
  app.post("/api/auth/disable", (req, reply) => run(async () => {
    await auth.disable(identity(req)); clearRefresh(req, reply); return { ok: true };
  }, reply));
}

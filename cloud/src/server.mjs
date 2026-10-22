import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.mjs";
import { createApp } from "./app.mjs";

// Local secrets (GITHUB_CLIENT_ID, ...) can live in cloud/.env, which git and Docker ignore.
// Variables already set win; production sets everything in its own environment.
try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // no .env: fine
}
const env = process.env;
// `--dev` and `--demo` stand in for DEV_LOGIN=1 / DEMO=1, which Windows shells can't set inline.
if (process.argv.includes("--dev") || process.argv.includes("--demo")) env.DEV_LOGIN = "1";
if (process.argv.includes("--demo")) env.DEMO = "1";
const production = env.NODE_ENV === "production";
if (production && !env.SESSION_SECRET) throw new Error("SESSION_SECRET is required in production");
if (production && env.DEV_LOGIN) throw new Error("DEV_LOGIN must not be set in production");
// Without this, a missing variable would boot on in-memory PGlite and lose every sync on restart.
if (production && !env.DATABASE_URL) throw new Error("DATABASE_URL is required in production");

const port = Number(env.PORT || 8787);
// Outside production only this machine can reach the server: dev sign-in takes any name, so it
// must never be open to the network. Production (Railway) listens on every interface.
const host = env.HOST || (production ? "0.0.0.0" : "127.0.0.1");
if (env.DEV_LOGIN === "1" && !["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("dev sign-in only listens on this machine (HOST=127.0.0.1)");
// Railway sets RAILWAY_PUBLIC_DOMAIN; an explicit PUBLIC_URL (a custom domain) wins.
const publicUrl = env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${port}`);
if (production && publicUrl.startsWith("http://localhost")) throw new Error("Set PUBLIC_URL (or deploy on Railway, which provides RAILWAY_PUBLIC_DOMAIN)");
const db = await openDb();
// Sample team data for local development; refused in production above via DEV_LOGIN.
if (env.DEV_LOGIN === "1" && env.DEMO === "1") await (await import("./demo.mjs")).seedDemo(db);
const handle = createApp({
  db,
  config: {
    publicUrl,
    // Behind Railway's proxy every request arrives from the proxy; the client is in X-Forwarded-For.
    trustProxy: env.TRUST_PROXY === "1" || !!env.RAILWAY_ENVIRONMENT,
    // Dev only (production refuses DEV_LOGIN above): a fixed secret keeps you signed in across restarts.
    sessionSecret: env.SESSION_SECRET || (env.DEV_LOGIN === "1" ? "snout-dev-only-session-secret" : undefined),
    githubClientId: env.GITHUB_CLIENT_ID,
    githubClientSecret: env.GITHUB_CLIENT_SECRET,
    devLogin: env.DEV_LOGIN === "1",
    earlyAccess: env.EARLY_ACCESS === "1",
    stripeKey: env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
    upgradeUrl: env.UPGRADE_URL,
    beta: env.BETA === "1",
    betaAllow: (env.BETA_ALLOW || "").split(",").map((c) => c.trim()),
    admins: (env.ADMIN_LOGINS || "").split(",").map((c) => c.trim()),
  },
});

const server = createServer(handle);
server.listen(port, host, () => process.stdout.write(`snout-cloud on ${publicUrl} (${db.engine}${env.DEV_LOGIN === "1" ? ", dev login on" : ""}${env.GITHUB_CLIENT_ID ? ", GitHub sign-in on" : ""})\n`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => db.close().then(() => process.exit(0))));

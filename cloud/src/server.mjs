import { createServer } from "node:http";
import { openDb } from "./db.mjs";
import { createApp } from "./app.mjs";

const env = process.env;
const production = env.NODE_ENV === "production";
if (production && !env.SESSION_SECRET) throw new Error("SESSION_SECRET is required in production");
if (production && env.DEV_LOGIN) throw new Error("DEV_LOGIN must not be set in production");
// Without this, a missing variable would boot on in-memory PGlite and lose every sync on restart.
if (production && !env.DATABASE_URL) throw new Error("DATABASE_URL is required in production");

const port = Number(env.PORT || 8787);
// Railway sets RAILWAY_PUBLIC_DOMAIN; an explicit PUBLIC_URL (a custom domain) wins.
const publicUrl = env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${port}`);
if (production && publicUrl.startsWith("http://localhost")) throw new Error("Set PUBLIC_URL (or deploy on Railway, which provides RAILWAY_PUBLIC_DOMAIN)");
const db = await openDb();
const handle = createApp({
  db,
  config: {
    publicUrl,
    // Behind Railway's proxy every request arrives from the proxy; the client is in X-Forwarded-For.
    trustProxy: env.TRUST_PROXY === "1" || !!env.RAILWAY_ENVIRONMENT,
    sessionSecret: env.SESSION_SECRET,
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
server.listen(port, () => process.stdout.write(`snout-cloud on :${port} (${db.engine}${env.DEV_LOGIN === "1" ? ", dev login on" : ""})\n`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => db.close().then(() => process.exit(0))));

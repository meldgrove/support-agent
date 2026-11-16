import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins";
import { eq, sql } from "drizzle-orm";
import { config } from "../config";
import { getDb } from "../db/client";
import { accounts, authRateLimits, sessions, users, verifications } from "../db/schema";
import { CLIENT_IP_HEADER } from "../http/client-ip";
import { logger } from "../logger";

/**
 * Sign-in only through the OpenID Connect provider. Nobody can sign up: a
 * person signs in when an admin added their email address (or it is in
 * ADMIN_EMAILS) and the account is active.
 */
function createAuth() {
  const settings = config();
  const appUrl = new URL(settings.APP_URL);
  return betterAuth({
    appName: settings.APP_NAME,
    baseURL: settings.APP_URL,
    basePath: "/api/auth",
    secret: settings.AUTH_SECRET,
    trustedOrigins: [settings.APP_URL],
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
        rateLimit: authRateLimits,
      },
    }),
    advanced: {
      database: { generateId: "uuid" },
      cookiePrefix: "support-agent",
      useSecureCookies: appUrl.protocol === "https:",
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    emailAndPassword: { enabled: false },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      // Short cache: deactivation takes effect within a minute.
      cookieCache: { enabled: true, maxAge: 60 },
    },
    account: {
      // People are added by email address in the admin interface (or
      // ADMIN_EMAILS); their first sign-in links the provider's account to
      // that entry. The organization's own provider vouches for the address.
      accountLinking: {
        enabled: true,
        trustedProviders: ["oidc"],
        allowDifferentEmails: false,
        requireLocalEmailVerified: false,
        updateUserInfoOnLink: true,
      },
    },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 100 },
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: "oidc",
            discoveryUrl: `${settings.OIDC_ISSUER.replace(/\/+$/, "")}/.well-known/openid-configuration`,
            clientId: settings.OIDC_CLIENT_ID,
            clientSecret: settings.OIDC_CLIENT_SECRET,
            scopes: settings.OIDC_SCOPES.split(/\s+/).filter(Boolean),
            pkce: settings.OIDC_PKCE,
            // Only people an admin added (or ADMIN_EMAILS) can sign in.
            disableImplicitSignUp: true,
            // Name and picture follow the provider at every sign-in.
            overrideUserInfo: true,
          },
        ],
      }),
    ],
    databaseHooks: {
      session: {
        create: {
          // Deactivated people cannot start a session.
          before: async (session) => {
            const [user] = await getDb()
              .select({ isActive: users.isActive })
              .from(users)
              .where(eq(users.id, session.userId));
            if (!user?.isActive) return false;
            return { data: session };
          },
          after: async (session) => {
            await getDb()
              .update(users)
              .set({ lastSignInAt: sql`now()` })
              .where(eq(users.id, session.userId))
              .catch((error: unknown) => logger.warn({ err: error }, "could not record the sign-in time"));
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
let instance: Auth | undefined;

/** The authentication library instance (created on first use, after configuration loads). */
export function auth(): Auth {
  instance ??= createAuth();
  return instance;
}

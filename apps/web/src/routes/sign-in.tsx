import { useState } from "react";
import { createRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { Bot, LogIn } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import { useAuthConfig } from "@/lib/auth-config";
import { apiUrl } from "@/lib/api";
import { defineMessages, useT } from "@/i18n";
import { rootRoute } from "./root";

const messages = defineMessages({
  en: {
    title: "Sign in",
    description: "Configure the support agents of your organization.",
    signInWith: "Sign in with {name}",
    signInSso: "Sign in",
    noAccess: "This account has no access. Ask an admin to add your email address.",
    failed: "Sign-in failed. Try again.",
  },
  de: {
    title: "Anmelden",
    description: "Richte die Support-Agenten deiner Organisation ein.",
    signInWith: "Mit {name} anmelden",
    signInSso: "Anmelden",
    noAccess: "Dieses Konto hat keinen Zugang. Bitte eine Admin-Person, deine E-Mail-Adresse hinzuzufügen.",
    failed: "Die Anmeldung ist fehlgeschlagen. Versuche es erneut.",
  },
});

const searchSchema = z.object({
  redirect: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
});

/** Only same-site paths, never another origin. */
export function safeRedirect(target: string | undefined): string {
  return target && target.startsWith("/") && !target.startsWith("//") && !target.startsWith("/sign-in")
    ? target
    : "/";
}

function SignInPage() {
  const t = useT(messages);
  const config = useAuthConfig();
  const search = signInRoute.useSearch();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const signIn = async () => {
    setPending(true);
    setFailed(false);
    // Better Auth 1.7 serves generic OAuth providers through the social sign-in.
    const result = await authClient.signIn.social({
      provider: "oidc",
      callbackURL: safeRedirect(search.redirect),
      errorCallbackURL: "/sign-in",
    });
    // On success the browser leaves for the identity provider.
    if (result.error) {
      setPending(false);
      setFailed(true);
    }
  };

  return (
    <main className="bg-muted/40 flex min-h-svh items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <div className="bg-primary text-primary-foreground mb-2 flex size-10 items-center justify-center rounded-lg">
              <Bot className="size-5" />
            </div>
            <CardTitle className="text-xl">
              <h1>{config?.appName ?? t("title")}</h1>
            </CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {search.error ? (
              <Alert variant="destructive">
                <AlertDescription>{t("noAccess")}</AlertDescription>
              </Alert>
            ) : null}
            {failed ? (
              <Alert variant="destructive">
                <AlertDescription>{t("failed")}</AlertDescription>
              </Alert>
            ) : null}
            <Button type="button" onClick={() => void signIn()} disabled={pending}>
              {pending ? <Spinner /> : <LogIn />}
              {config ? t("signInWith", { name: config.providerName }) : t("signInSso")}
            </Button>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

export const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  validateSearch: searchSchema,
  beforeLoad: async ({ search }) => {
    // Signed in already: go on to the app. A plain request, so a 401 doesn't trigger the sign-out handling.
    const response = await fetch(apiUrl("/me"), {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    }).catch(() => null);
    if (response?.ok) throw redirect({ to: safeRedirect(search.redirect) });
  },
  component: SignInPage,
});

import { useId, useState } from "react";
import { Save, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import type { UpdateChannel, UpdaterStatus } from "@support-agent/shared/api/updates";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useT } from "@/i18n";
import { common } from "@/i18n/common";
import { errorMessage } from "@/lib/api";
import { useSetUpdateChannel, useUpdates } from "./api";
import { messages } from "./messages";
import { parseCooldown, parseWindow } from "./state";

const DEPLOYMENT_GUIDE =
  "https://github.com/meldgrove/support-agent/blob/main/docs/deployment.md#automatic-updates";

type T = ReturnType<typeof useT<typeof messages.en>>;

function cooldownText(t: T, cooldown: string | null): string | null {
  const parsed = parseCooldown(cooldown);
  return parsed ? t(parsed.unit, { count: parsed.count }) : null;
}

/** When updates install by themselves on this server. */
function automaticText(t: T, status: UpdaterStatus): string {
  if (status.mode === "off") return t("automaticOff");
  if (status.mode === "platform") return t("automaticPlatform");
  const hours = parseWindow(status.window);
  const windowText = hours ? t("automaticWindow", { ...hours, timezone: status.timezone }) : "";
  const cooldown = status.channel === "stable" ? cooldownText(t, status.cooldown) : null;
  return cooldown
    ? t("automaticStable", { cooldown, window: windowText })
    : t("automaticSoon", { window: windowText });
}

/** The "Updates" section of the settings page: installed version, channel, automatic installs. */
export function UpdatesSection() {
  const t = useT(messages);
  const tc = useT(common);
  const id = useId();
  const updates = useUpdates();
  const save = useSetUpdateChannel();
  const [choice, setChoice] = useState<UpdateChannel | null>(null);

  const response = updates.data;
  const status = response?.reachable ? response.updater : null;
  const channel = choice ?? status?.channel ?? "stable";
  const disabled = !status || status.channelLocked !== null || save.isPending;
  const dirty = status !== null && choice !== null && choice !== status.channel;
  const cooldown = cooldownText(t, status?.cooldown ?? null);

  const submit = async () => {
    if (!dirty) return;
    try {
      const result = await save.mutateAsync(choice);
      setChoice(null);
      if (result.reachable) toast.success(t("channelSaved"));
      else toast.error(result.error ?? t("unreachable"));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const [before, after] = t("notReachable").split("{guide}");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("updates")}</CardTitle>
        <CardDescription>
          {t("installed")}: {response?.app.version ?? t("development")}
          {status ? ` · ${t(status.channel)}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        {updates.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : !status ? (
          <Alert>
            <TriangleAlert />
            <AlertDescription>
              <p>
                {before}
                <a
                  href={DEPLOYMENT_GUIDE}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-4"
                >
                  {t("deploymentGuide")}
                </a>
                {after}
              </p>
              {response?.error ? <p className="break-words">{response.error}</p> : null}
            </AlertDescription>
          </Alert>
        ) : null}
        <FieldSet className="gap-3">
          <FieldLegend variant="label" className="mb-1">
            {t("channel")}
          </FieldLegend>
          <RadioGroup
            value={channel}
            onValueChange={(value) => setChoice(value as UpdateChannel)}
            disabled={disabled}
          >
            <Field orientation="horizontal" data-disabled={disabled || undefined}>
              <RadioGroupItem value="stable" id={`${id}-stable`} />
              <FieldContent>
                <FieldLabel htmlFor={`${id}-stable`}>
                  {t("stable")}{" "}
                  <span className="text-muted-foreground font-normal">({t("recommended")})</span>
                </FieldLabel>
                <FieldDescription>
                  {cooldown && status?.channel === "stable"
                    ? t("stableHint", { cooldown })
                    : t("stableHintNoCooldown")}
                </FieldDescription>
              </FieldContent>
            </Field>
            <Field orientation="horizontal" data-disabled={disabled || undefined}>
              <RadioGroupItem value="preview" id={`${id}-preview`} />
              <FieldContent>
                <FieldLabel htmlFor={`${id}-preview`}>{t("preview")}</FieldLabel>
                <FieldDescription>{t("previewHint")}</FieldDescription>
              </FieldContent>
            </Field>
          </RadioGroup>
          {status?.channelLocked ? (
            <p className="text-sm font-medium break-words">{status.channelLocked}</p>
          ) : null}
          <FieldDescription>{t("switchBack")}</FieldDescription>
        </FieldSet>
        {status ? (
          <div className="grid gap-1 text-sm">
            <p className="font-medium">{t("automatic")}</p>
            <p className="text-muted-foreground">{automaticText(t, status)}</p>
          </div>
        ) : null}
      </CardContent>
      <CardFooter className="justify-end gap-2">
        {dirty ? (
          <Button type="button" variant="outline" disabled={save.isPending} onClick={() => setChoice(null)}>
            {tc("discard")}
          </Button>
        ) : null}
        <Button type="button" disabled={!dirty || save.isPending} onClick={() => void submit()}>
          {save.isPending ? <Spinner /> : <Save />}
          {tc("save")}
        </Button>
      </CardFooter>
    </Card>
  );
}

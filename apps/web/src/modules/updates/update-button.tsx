import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Download, ExternalLink, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import type { Update, UpdatesResponse } from "@support-agent/shared/api/updates";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsAdmin } from "@/hooks/use-me";
import { useT } from "@/i18n";
import { errorMessage } from "@/lib/api";
import { useAuthConfig } from "@/lib/auth-config";
import { useFormatter } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useCheckUpdates, useInstallUpdate, useUpdates } from "./api";
import { messages } from "./messages";
import { DEPLOYMENT_GUIDE } from "./updates-section";
import {
  buttonState,
  installOutcome,
  installsAt,
  loadWaiting,
  noteSummary,
  saveWaiting,
  startWaiting,
  type ButtonState,
  type Waiting,
} from "./state";

const DEFAULT_APP_NAME = "Support Agent";
/** The systemd unit of the host setup, for a server set up as in docs/deployment.md. */
const HOST_UNIT = "meldgrove-updater-support-agent";

type T = ReturnType<typeof useT<typeof messages.en>>;

/** The update button in the header: admins only. */
export function UpdateButton() {
  return useIsAdmin() ? <AdminUpdateButton /> : null;
}

function AdminUpdateButton() {
  const t = useT(messages);
  const appName = useAuthConfig()?.appName || DEFAULT_APP_NAME;
  const [waiting, setWaitingState] = useState<Waiting | null>(loadWaiting);
  const updates = useUpdates({ waiting: waiting !== null });
  const check = useCheckUpdates();
  const install = useInstallUpdate();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ update: Update; attention: boolean } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const finished = useRef(false);

  const setWaiting = (next: Waiting | null) => {
    saveWaiting(next);
    setWaitingState(next);
  };

  const response = updates.data;
  const failing = updates.isError;
  // An installation started elsewhere (another admin, automatically) reloads this page too.
  const runningVersion = response?.updater?.installing?.version;
  useEffect(() => {
    if (runningVersion && !waiting) setWaiting(startWaiting(runningVersion, response, Date.now()));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when an installation appears
  }, [runningVersion, waiting]);

  useEffect(() => {
    if (!waiting || finished.current) return;
    if (failing) {
      if (!waiting.outage) setWaiting({ ...waiting, outage: true });
      return;
    }
    if (!response) return;
    const outcome = installOutcome(waiting, response);
    if (outcome === "done") {
      finished.current = true;
      saveWaiting(null);
      toast.success(t("updated", { version: waiting.version }));
      setTimeout(() => window.location.reload(), 1_500);
    } else if (outcome === "failed") {
      setWaiting(null);
      setOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on every answer
  }, [updates.dataUpdatedAt, updates.errorUpdatedAt, failing, waiting]);

  const now = Date.now();
  const state = buttonState({ response, waiting, checking: check.isPending, failing, now });
  if (!state) return null;
  // The popover keeps its content while a check from it runs.
  const content = buttonState({ response, waiting, checking: false, failing, now });
  const status = response?.updater ?? null;
  const installedVersion = status?.installed ?? response?.app.version ?? null;

  const runCheck = async (fromButton: boolean) => {
    try {
      const result = await check.mutateAsync();
      const error = result.reachable ? result.updater?.error : result.error;
      if (error) {
        toast.error(error);
        return;
      }
      const next = buttonState({
        response: result,
        waiting: null,
        checking: false,
        failing: false,
        now: Date.now(),
      });
      if (!fromButton) return;
      if (next?.kind === "current") {
        toast.success(t("upToDate") + (installedVersion ? ` · ${installedVersion}` : ""));
      } else if (next && next.kind !== "unreachable") {
        setOpen(true);
      }
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const runInstall = async (update: Update) => {
    const before = response;
    try {
      await install.mutateAsync(update.version);
      finished.current = false;
      setWaiting(startWaiting(update.version, before, Date.now()));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const askInstall = (update: Update, attention: boolean) => {
    setOpen(false);
    setConfirm({ update, attention });
    setConfirmOpen(true);
  };

  const hasPopover = content !== null && hasPopoverContent(content);
  const onClick = (event: MouseEvent) => {
    if (hasPopover) return;
    // Nothing to show: the click checks (up to date) or asks for the status again.
    event.preventDefault();
    if (state.kind === "current" || state.kind === "off") void runCheck(true);
    else if (state.kind === "unreachable") void updates.refetch();
  };

  const label = tooltip(state, t, installedVersion);

  return (
    <>
      <Popover open={open && hasPopover} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn("relative rounded-full", state.kind === "unreachable" && "opacity-60")}
                aria-label={label}
                onClick={onClick}
              >
                <ButtonIcon state={state} />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end">
            {label}
          </TooltipContent>
        </Tooltip>
        <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
          {content ? (
            <div className="grid gap-3 text-sm">
              <PopoverBody
                state={content}
                t={t}
                appName={appName}
                installedVersion={installedVersion}
                installable={status?.mode !== "off"}
                onInstall={askInstall}
              />
              <Separator />
              <PopoverFooter
                t={t}
                response={response}
                installedVersion={installedVersion}
                checking={check.isPending}
                disabled={content.kind === "installing"}
                onCheck={() => void runCheck(false)}
              />
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={
          confirm
            ? t(confirm.attention ? "confirmAttentionTitle" : "confirmTitle", {
                version: confirm.update.version,
              })
            : null
        }
        description={t("confirmText", { app: appName })}
        confirmLabel={t("install")}
        destructive={confirm?.attention}
        onConfirm={() => (confirm ? runInstall(confirm.update) : undefined)}
      >
        {confirm?.attention ? (
          <p className="text-muted-foreground text-sm">
            {t("confirmAttentionText")} <ReleaseNotesLink url={confirm.update.url} t={t} />
          </p>
        ) : null}
      </ConfirmDialog>
    </>
  );
}

function hasPopoverContent(state: ButtonState): boolean {
  switch (state.kind) {
    case "available":
    case "attention":
    case "failed":
    case "installing":
      return true;
    default:
      return false;
  }
}

function tooltip(state: ButtonState, t: T, installed: string | null): string {
  switch (state.kind) {
    case "unreachable":
      return t("unreachable");
    case "installing":
      return state.stage === "restarting" ? t("restarting") : t("installing", { version: state.version });
    case "checking":
      return t("checking");
    case "off":
      return t("off");
    case "failed":
      return t("failedTitle", { version: state.version });
    case "available":
      return `${t("available")} · ${state.update.version}`;
    case "attention":
      return t("attentionTitle", { version: state.update.version });
    case "current":
      return t("upToDate") + (installed ? ` · ${installed}` : "");
  }
}

function ButtonIcon({ state }: { state: ButtonState }) {
  switch (state.kind) {
    case "checking":
      return <RefreshCw className="motion-safe:animate-spin" />;
    case "installing":
      return <LoaderCircle className="motion-safe:animate-spin" />;
    case "failed":
      return <TriangleAlert className="text-destructive" />;
    case "available":
    case "attention":
      return (
        <>
          <Download />
          <span
            aria-hidden
            className={cn(
              "ring-background absolute top-1 right-1 size-2 rounded-full ring-2",
              state.kind === "available" ? "bg-primary" : "bg-warning",
            )}
          />
        </>
      );
    default:
      return <RefreshCw className="text-muted-foreground" />;
  }
}

function ReleaseNotesLink({ url, t }: { url: string | null; t: T }) {
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="text-foreground inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
    >
      {t("releaseNotes")}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}

function UpdateDetails({ update, t, title }: { update: Update; t: T; title: ReactNode }) {
  const format = useFormatter();
  const { notes, more } = noteSummary(update);
  const when = installsAt(update, Date.now());
  return (
    <div className="grid gap-2">
      <div className="grid gap-0.5">
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="break-all">
            {update.version}
            {update.publishedAt ? ` · ${format.relative(update.publishedAt)}` : ""}
          </span>
          {update.preview ? <Badge variant="secondary">{t("preview")}</Badge> : null}
        </p>
      </div>
      {notes.length > 0 ? (
        <ul className="grid list-disc gap-1 pl-4">
          {notes.map((note, index) => (
            <li key={index} className="break-words">
              {note}
            </li>
          ))}
        </ul>
      ) : null}
      {more > 0 ? <p className="text-muted-foreground">{t("moreChanges", { count: more })}</p> : null}
      <ReleaseNotesLink url={update.url} t={t} />
      {when === "next-check" ? (
        <p className="text-muted-foreground">{t("installsNextCheck")}</p>
      ) : when ? (
        <p className="text-muted-foreground">{t("installsOn", { date: format.dateTime(when.at) })}</p>
      ) : null}
    </div>
  );
}

function PopoverBody(props: {
  state: ButtonState;
  t: T;
  appName: string;
  installedVersion: string | null;
  /** False in mode off: the popover shows the update, but nothing can install from here. */
  installable: boolean;
  onInstall: (update: Update, attention: boolean) => void;
}) {
  const { state, t } = props;
  switch (state.kind) {
    case "available":
      return (
        <>
          <UpdateDetails update={state.update} t={t} title={t("available")} />
          {props.installable ? (
            <Button size="sm" onClick={() => props.onInstall(state.update, false)}>
              <Download />
              {t("installNow")}
            </Button>
          ) : (
            <OffNote t={t} />
          )}
          {state.attention ? (
            <>
              <Separator />
              <AttentionBody
                update={state.attention}
                t={t}
                onInstall={props.installable ? props.onInstall : null}
              />
            </>
          ) : null}
        </>
      );
    case "attention":
      return (
        <AttentionBody update={state.update} t={t} onInstall={props.installable ? props.onInstall : null} />
      );
    case "failed":
      return (
        <div className="grid gap-2">
          <p className="text-destructive flex items-center gap-2 font-medium">
            <TriangleAlert className="size-4 shrink-0" aria-hidden />
            {t("failedTitle", { version: state.version })}
          </p>
          {state.message ? <p className="text-muted-foreground break-words">{state.message}</p> : null}
          {props.installedVersion ? <p>{t("stillRunning", { version: props.installedVersion })}</p> : null}
          {props.installable ? (
            <Button size="sm" variant="outline" onClick={() => props.onInstall(state.update, false)}>
              <RefreshCw />
              {t("tryAgain")}
            </Button>
          ) : (
            <OffNote t={t} />
          )}
        </div>
      );
    case "installing":
      return (
        <div className="grid gap-2">
          <p className="flex items-center gap-2 font-medium">
            <LoaderCircle className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden />
            {t("installing", { version: state.version })}
          </p>
          {state.stage ? (
            <p className="text-muted-foreground">
              {state.stage === "restarting"
                ? t("restarting")
                : state.stage === "rolling-back"
                  ? t("stage_rollingBack", { version: props.installedVersion ?? "" })
                  : t(`stage_${state.stage}`)}
            </p>
          ) : null}
          <p>{t("restarts", { app: props.appName })}</p>
          {state.slow ? (
            <p className="text-destructive break-words">
              {t("slow", { command: `journalctl -u ${HOST_UNIT}` })}
            </p>
          ) : null}
        </div>
      );
    default:
      return null;
  }
}

/** In mode off, in place of the install buttons: nothing can install from here. */
function OffNote({ t }: { t: T }) {
  const [before, after] = t("offCannotInstall").split("{guide}");
  return (
    <p className="text-muted-foreground">
      {before}
      <a
        href={DEPLOYMENT_GUIDE}
        target="_blank"
        rel="noreferrer"
        className="text-foreground font-medium underline-offset-4 hover:underline"
      >
        {t("deploymentGuide")}
      </a>
      {after}
    </p>
  );
}

function AttentionBody(props: {
  update: Update;
  t: T;
  /** null in mode off: nothing can install from here. */
  onInstall: ((update: Update, attention: boolean) => void) | null;
}) {
  const { update, t } = props;
  return (
    <div className="grid gap-2">
      <p className="flex items-center gap-2 font-medium">
        <span aria-hidden className="bg-warning size-2 shrink-0 rounded-full" />
        {t("attentionTitle", { version: update.version })}
      </p>
      <p className="text-muted-foreground">{t("attentionText")}</p>
      <ReleaseNotesLink url={update.url} t={t} />
      {props.onInstall ? (
        <Button size="sm" variant="outline" onClick={() => props.onInstall?.(update, true)}>
          {t("installAnyway")}
        </Button>
      ) : (
        <OffNote t={t} />
      )}
    </div>
  );
}

function PopoverFooter(props: {
  t: T;
  response: UpdatesResponse | undefined;
  installedVersion: string | null;
  checking: boolean;
  disabled: boolean;
  onCheck: () => void;
}) {
  const { t, response } = props;
  const format = useFormatter();
  const status = response?.updater ?? null;
  const checkedAt = status?.checkedAt;
  return (
    <div className="text-muted-foreground grid gap-1 text-xs">
      <p>
        {t("installed")}: {props.installedVersion ?? t("development")}
        {status ? ` · ${t(status.channel)}` : ""}
      </p>
      <p className="flex flex-wrap items-center gap-x-1">
        <span>{checkedAt ? t("checked", { time: format.relative(checkedAt) }) : t("notChecked")}</span>
        <span aria-hidden>·</span>
        <Button
          variant="link"
          size="xs"
          className="h-auto p-0 text-xs has-[>svg]:px-0"
          disabled={props.checking || props.disabled}
          onClick={props.onCheck}
        >
          {props.checking ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : null}
          {t("checkNow")}
        </Button>
      </p>
      {status?.error ? <p className="text-destructive break-words">{status.error}</p> : null}
    </div>
  );
}

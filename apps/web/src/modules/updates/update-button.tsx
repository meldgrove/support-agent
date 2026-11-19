import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Download, ExternalLink, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import type { Update, UpdatesResponse, UpdaterStatus } from "@support-agent/shared/api/updates";
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
import { isSignedOut, useCheckUpdates, useInstallUpdate, useUpdates } from "./api";
import { messages } from "./messages";
import { DEPLOYMENT_GUIDE } from "./updates-section";
import {
  adoptWaiting,
  afterInstallAnswer,
  afterStatusError,
  buttonState,
  follow,
  ignoreWaiting,
  installAction,
  installOutcome,
  installsAt,
  isIgnored,
  loadIgnored,
  loadWaiting,
  noteSummary,
  reconcileDeadline,
  saveIgnored,
  saveWaiting,
  SLOW_AFTER_MS,
  startWaiting,
  unconfirmedEnd,
  type ButtonState,
  type Failure,
  type Ignored,
  type Tracked,
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
  const deadline = reconcileDeadline(waiting);
  const updates = useUpdates({ waiting: waiting !== null, deadline });
  const check = useCheckUpdates();
  const install = useInstallUpdate();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ update: Update; attention: boolean } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** The failure of the installation this page followed. */
  const [tracked, setTracked] = useState<Tracked | null>(null);
  /** An installation the admin stopped waiting for: not followed again. */
  const [ignored, setIgnoredState] = useState<Ignored | null>(loadIgnored);
  const setIgnored = (next: Ignored | null) => {
    saveIgnored(next);
    setIgnoredState(next);
  };
  const finished = useRef(false);
  const reloadTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(reloadTimer.current), []);

  const current = useRef(waiting);
  const setWaiting = (next: Waiting | null) => {
    current.current = next;
    saveWaiting(next);
    setWaitingState(next);
  };

  const response = updates.data;
  const receivedAt = updates.dataUpdatedAt;
  const failing = updates.isError;
  const signedOut = isSignedOut(updates.error);
  // Follow an installation that a status reports (a poll, a check, a refusal):
  // another admin's, an automatic one, or a newer one than the attempt.
  const running = response?.updater?.installing ?? null;
  useEffect(() => {
    if (!running || !response || finished.current || install.isPending) return;
    if (waiting?.version === running.version || isIgnored(ignored, running)) return;
    setTracked(null);
    setWaiting(adoptWaiting(response, Date.now()));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when an installation appears
  }, [running?.version, running?.startedAt, waiting?.version, install.isPending]);

  useEffect(() => {
    if (!waiting || finished.current || install.isPending) return;
    if (failing) {
      // Expected while the app restarts; signed out: keep the attempt for a later page load.
      if (signedOut || updates.errorUpdatedAt < waiting.since) return;
      const next = afterStatusError(waiting, errorMessage(updates.error));
      if (next !== waiting) setWaiting(next);
      return;
    }
    if (!response) return;
    const followed = follow(waiting, response, receivedAt);
    const outcome = installOutcome(followed, response, receivedAt);
    if (outcome === "done") {
      finished.current = true;
      saveWaiting(null);
      toast.success(t("updated", { version: waiting.version }));
      reloadTimer.current = setTimeout(() => window.location.reload(), 1_500);
    } else if (outcome === "failed") {
      const last = response.updater?.last;
      setTracked(last ? { version: last.version, finishedAt: last.finishedAt } : null);
      setWaiting(null);
      setOpen(true);
    } else if (followed !== waiting) {
      setWaiting(followed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on every answer
  }, [receivedAt, updates.errorUpdatedAt, failing, waiting, install.isPending]);

  // An unconfirmed attempt ends 60 s after it started (its stored start
  // time), whatever the polls return or whether one ran at all (errors, 5xx,
  // no updater, requests that hang or wait for the network). Signed out:
  // kept for a later page load.
  useEffect(() => {
    if (deadline === null || signedOut) return;
    const since = current.current?.since;
    const timer = setTimeout(
      () => {
        const latest = current.current;
        if (!latest || latest.confirmed || latest.since !== since || finished.current) return;
        const end = unconfirmedEnd(latest);
        setWaiting(null);
        toast.error(t(end.message), { description: end.detail ?? undefined });
      },
      Math.max(0, deadline - Date.now()),
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per attempt
  }, [deadline, signedOut]);

  // Shows "This takes longer than expected" after 15 minutes, also when no poll returns.
  const [, setSlowTick] = useState(0);
  const since = waiting?.since;
  useEffect(() => {
    if (since === undefined) return;
    const left = since + SLOW_AFTER_MS - Date.now();
    if (left < 0) return;
    const timer = setTimeout(() => setSlowTick((tick) => tick + 1), left + 1);
    return () => clearTimeout(timer);
  }, [since]);

  const now = Date.now();
  const input = { response, receivedAt, waiting, tracked, failing, now };
  const state = buttonState({ ...input, checking: check.isPending });
  if (!state) return null;
  // The popover keeps its content while a check from it runs.
  const content = buttonState({ ...input, checking: false });
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
        receivedAt: Date.now(),
        waiting: null,
        tracked,
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
    // Remembered before the request: an answer that never arrives must not lose it.
    const attempt = startWaiting(update.version, response, Date.now());
    finished.current = false;
    setTracked(null);
    setIgnored(null);
    setWaiting(attempt);
    const answer = await install.mutateAsync(update.version);
    // Unless an answer of the status already settled the attempt.
    const latest = current.current;
    const next = afterInstallAnswer(latest?.since === attempt.since ? latest : attempt, answer, Date.now());
    if (latest?.since === attempt.since && !finished.current) setWaiting(next.waiting);
    if (next.error) toast.error(next.error);
  };

  const stopWaiting = () => {
    if (!waiting) return;
    // By the identity stored on the attempt: the latest answer may have no status.
    setIgnored(ignoreWaiting(waiting));
    setWaiting(null);
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
                status={status}
                onInstall={askInstall}
                onStopWaiting={waiting && !signedOut ? stopWaiting : null}
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
  /** Decides what can install from here (`installAction`). */
  status: UpdaterStatus | null;
  onInstall: (update: Update, attention: boolean) => void;
  /** While the page follows an installation. */
  onStopWaiting: (() => void) | null;
}) {
  const { state, t, status } = props;
  const action = (attention: boolean) => (status ? installAction(status, attention) : "off");
  switch (state.kind) {
    case "available":
      return (
        <>
          {state.failure ? <FailureLine failure={state.failure} t={t} /> : null}
          <UpdateDetails update={state.update} t={t} title={t("available")} />
          {action(false) === "install" ? (
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
                appName={props.appName}
                action={action(true)}
                onInstall={props.onInstall}
              />
            </>
          ) : null}
        </>
      );
    case "attention":
      return (
        <>
          {state.failure ? <FailureLine failure={state.failure} t={t} /> : null}
          <AttentionBody
            update={state.update}
            t={t}
            appName={props.appName}
            action={action(true)}
            onInstall={props.onInstall}
          />
        </>
      );
    case "failed": {
      const { update, attention } = state;
      const retry = update ? action(attention) : null;
      return (
        <div className="grid gap-2">
          <p className="text-destructive flex items-center gap-2 font-medium">
            <TriangleAlert className="size-4 shrink-0" aria-hidden />
            {t("failedTitle", { version: state.version })}
          </p>
          {state.message ? <p className="text-muted-foreground break-words">{state.message}</p> : null}
          {props.installedVersion ? <p>{t("stillRunning", { version: props.installedVersion })}</p> : null}
          {update && retry === "install" ? (
            <Button size="sm" variant="outline" onClick={() => props.onInstall(update, attention)}>
              <RefreshCw />
              {t("tryAgain")}
            </Button>
          ) : retry === "tag" ? (
            <TagNote t={t} appName={props.appName} version={state.version} />
          ) : retry === "off" ? (
            <OffNote t={t} />
          ) : null}
        </div>
      );
    }
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
          {state.following ? <p>{t("restarts", { app: props.appName })}</p> : null}
          {state.slow ? (
            <>
              <p className="text-destructive break-words">
                {t("slow", { command: `journalctl -u ${HOST_UNIT}` })}
              </p>
              {props.onStopWaiting ? (
                <Button size="sm" variant="outline" onClick={props.onStopWaiting}>
                  {t("stopWaiting")}
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      );
    default:
      return null;
  }
}

/** A followed installation that failed, above the newer offer that replaced it. */
function FailureLine({ failure, t }: { failure: Failure; t: T }) {
  return (
    <p className="text-destructive flex items-start gap-2 break-words">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        {failure.message
          ? t("failedLine", { version: failure.version, message: failure.message })
          : t("failedTitle", { version: failure.version })}
      </span>
    </p>
  );
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

/** An attention release that the image tag set where the app is deployed does not reach. */
function TagNote({ t, appName, version }: { t: T; appName: string; version: string }) {
  return <p className="text-muted-foreground">{t("attentionTag", { app: appName, version })}</p>;
}

function AttentionBody(props: {
  update: Update;
  t: T;
  appName: string;
  action: "install" | "off" | "tag";
  onInstall: (update: Update, attention: boolean) => void;
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
      {props.action === "install" ? (
        <Button size="sm" variant="outline" onClick={() => props.onInstall(update, true)}>
          {t("installAnyway")}
        </Button>
      ) : props.action === "tag" ? (
        <TagNote t={t} appName={props.appName} version={update.version} />
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

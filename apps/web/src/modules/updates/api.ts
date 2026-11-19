import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpdateChannel, UpdatesResponse } from "@support-agent/shared/api/updates";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { InstallAnswer } from "./state";

export const updatesQueryKey = ["updates"] as const;

/** The session ended or is no longer an admin's: polling stops (the attempt stays for a later page load). */
export function isSignedOut(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

function isUpdatesResponse(value: unknown): value is UpdatesResponse {
  const body = value as Partial<UpdatesResponse> | null | undefined;
  return typeof body?.reachable === "boolean" && typeof body.app === "object" && body.app !== null;
}

/** How long one status request may take; the app's own call to the updater takes at most 3 s. */
const STATUS_TIMEOUT_MS = 10_000;

/** The status, or an error after `timeoutMs`: a request that hangs must not stop the polling. */
async function getStatus(signal: AbortSignal, timeoutMs: number): Promise<UpdatesResponse> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort);
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await api.get<unknown>("/updates", undefined, controller.signal);
    // Anything else (a sign-in page after a redirect) means the session is gone.
    if (!isUpdatesResponse(response)) throw new ApiError(401, "unauthorized", "Not signed in");
    return response;
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) {
      throw new Error(`The app did not answer within ${Math.ceil(timeoutMs / 1000)} seconds.`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

/**
 * The update status: on page load, every 5 minutes, and on window focus at
 * most once a minute; every 2 seconds while the page waits for an
 * installation. Checks run only on request. After a 401, a 403 or a sign-in
 * page, no automatic request runs any more (interval, focus, reconnect).
 * Before `deadline` (an unconfirmed attempt's end), each request gets at
 * most the time left.
 */
export function useUpdates(options: { waiting?: boolean; deadline?: number | null } = {}) {
  const automatic = (query: { state: { error: unknown } }) => !isSignedOut(query.state.error);
  return useQuery({
    queryKey: updatesQueryKey,
    queryFn: ({ signal }) => {
      const left = options.deadline ? options.deadline - Date.now() : 0;
      return getStatus(signal, left > 0 ? Math.min(left, STATUS_TIMEOUT_MS) : STATUS_TIMEOUT_MS);
    },
    staleTime: 60_000,
    refetchInterval: (query) => (!automatic(query) ? false : options.waiting ? 2_000 : 5 * 60_000),
    refetchIntervalInBackground: options.waiting ?? false,
    refetchOnWindowFocus: automatic,
    refetchOnReconnect: automatic,
    // A failed request while the app restarts is expected; the next poll tries again.
    retry: false,
  });
}

/** The answer of a refused request (409): the reason and the latest status. */
function refusedResponse(error: unknown): UpdatesResponse | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  return isUpdatesResponse(error.body) ? error.body : null;
}

function useUpdatesMutation<T>(request: (input: T) => Promise<UpdatesResponse>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (response) => client.setQueryData(updatesQueryKey, response),
    onError: (error) => {
      const response = refusedResponse(error);
      if (response) client.setQueryData(updatesQueryKey, response);
    },
  });
}

export function useCheckUpdates() {
  return useUpdatesMutation<void>(() => api.post<UpdatesResponse>("/updates/check"));
}

/** Asks to install a version; never throws: the answer decides what the page does (`afterInstallAnswer`). */
async function requestInstall(version: string): Promise<InstallAnswer> {
  try {
    const { status, data } = await api.postWithStatus<UpdatesResponse>("/updates/install", { version });
    return { httpStatus: status, response: isUpdatesResponse(data) ? data : null, error: null };
  } catch (error) {
    if (!(error instanceof ApiError)) return { httpStatus: null, response: null, error: errorMessage(error) };
    return {
      httpStatus: error.status,
      response: isUpdatesResponse(error.body) ? error.body : null,
      error: error.message,
    };
  }
}

export function useInstallUpdate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: requestInstall,
    onSuccess: (answer) => {
      if (answer.response) client.setQueryData(updatesQueryKey, answer.response);
    },
  });
}

export function useSetUpdateChannel() {
  return useUpdatesMutation<UpdateChannel>((channel) =>
    api.post<UpdatesResponse>("/updates/channel", { channel }),
  );
}

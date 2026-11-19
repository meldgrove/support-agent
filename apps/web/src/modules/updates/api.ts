import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpdateChannel, UpdatesResponse } from "@support-agent/shared/api/updates";
import { api, ApiError } from "@/lib/api";

export const updatesQueryKey = ["updates"] as const;

/**
 * The update status: on page load, every 5 minutes, and on window focus at
 * most once a minute; every 2 seconds while the page waits for an
 * installation. Checks run only on request.
 */
export function useUpdates(options: { waiting?: boolean } = {}) {
  return useQuery({
    queryKey: updatesQueryKey,
    queryFn: ({ signal }) => api.get<UpdatesResponse>("/updates", undefined, signal),
    staleTime: 60_000,
    refetchInterval: options.waiting ? 2_000 : 5 * 60_000,
    refetchIntervalInBackground: options.waiting ?? false,
    // A failed request while the app restarts is expected; the next poll tries again.
    retry: false,
  });
}

/** The answer of a refused request (409): the reason and the latest status. */
function refusedResponse(error: unknown): UpdatesResponse | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const body = error.body as Partial<UpdatesResponse> | undefined;
  return body && typeof body.reachable === "boolean" && "app" in body ? (body as UpdatesResponse) : null;
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

export function useInstallUpdate() {
  return useUpdatesMutation<string>((version) => api.post<UpdatesResponse>("/updates/install", { version }));
}

export function useSetUpdateChannel() {
  return useUpdatesMutation<UpdateChannel>((channel) =>
    api.post<UpdatesResponse>("/updates/channel", { channel }),
  );
}

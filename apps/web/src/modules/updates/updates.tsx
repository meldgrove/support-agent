import { useCallback, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { UpdatesProvider, UpdatesSettingsCard } from "@meldgrove/ui/updates";
import { meQuery, useIsAdmin } from "@/hooks/use-me";
import { apiUrl } from "@/lib/api";

/** For admins without an update service: the deployment guide's section on automatic updates. */
const DEPLOYMENT_GUIDE =
  "https://github.com/meldgrove/support-agent/blob/main/docs/deployment.md#automatic-updates";

/**
 * Admins: the update status that the header button and the Updates section
 * of the settings share (polling, installing, following the restart).
 * Everyone else gets 403 from the routes, so nothing asks for them.
 */
export function AdminUpdates({ appName, children }: { appName: string; children: ReactNode }) {
  const admin = useIsAdmin();
  const queryClient = useQueryClient();
  // The routes answered 401 or 403 and the page stopped asking. Ask who is
  // signed in: an ended session shows the sign-in page, as every API request
  // does; a lost admin role hides the button.
  const onSignedOut = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: meQuery.queryKey }),
    [queryClient],
  );
  if (!admin) return children;
  return (
    <UpdatesProvider
      appName={appName}
      // The Compose project of a server set up as in docs/deployment.md (unit meldgrove-updater-support-agent).
      project="support-agent"
      url={apiUrl("/updates")}
      guideUrl={DEPLOYMENT_GUIDE}
      onSignedOut={onSignedOut}
    >
      {children}
    </UpdatesProvider>
  );
}

/** The "Updates" section of the settings: admins only. */
export function AdminUpdatesSettings() {
  return useIsAdmin() ? <UpdatesSettingsCard /> : null;
}

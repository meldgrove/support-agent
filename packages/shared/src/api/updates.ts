import { z } from "zod";

/**
 * In-app updates: the app's admin routes (`/updates`) in front of the
 * Meldgrove Updater's API (`UPDATER_URL`). The updater's `Status` and
 * `Update` are its contract
 * (https://github.com/meldgrove/updater#the-apps-update-button); change both
 * sides together.
 */

export const UPDATE_CHANNELS = ["stable", "preview"] as const;
export const updateChannelSchema = z.enum(UPDATE_CHANNELS);
export type UpdateChannel = z.infer<typeof updateChannelSchema>;

/** A release (`0.2.1`), a preview (`0.2.1-preview.3`) or an image without version (`sha256:<12 hex>`). */
export const updateVersionSchema = z
  .string()
  .regex(
    /^(?:[0-9]+\.[0-9]+\.[0-9]+(?:-preview\.[0-9]+)?|sha256:[0-9a-f]{12})$/,
    "Not a version the updater offers",
  );

export const installUpdateSchema = z.object({ version: updateVersionSchema });
export type InstallUpdate = z.infer<typeof installUpdateSchema>;

export const setUpdateChannelSchema = z.object({ channel: updateChannelSchema });
export type SetUpdateChannel = z.infer<typeof setUpdateChannelSchema>;

export const INSTALL_STAGES = ["requested", "pulling", "starting", "rolling-back", "deploying"] as const;
export const INSTALL_RESULTS = ["installed", "failed", "rolled-back", "accepted"] as const;

export const updateSchema = z.object({
  version: z.string(),
  preview: z.boolean(),
  publishedAt: z.string().nullable(),
  /** Release notes, or the compare view of a preview. */
  url: z.string().nullable(),
  /** Change titles, newest release first, at most 15. */
  notes: z.array(z.string()),
  /** All changes, when more than `notes`. */
  changes: z.number().int(),
  /** Automatic install time; null: not automatic. */
  installsAt: z.string().nullable(),
  /** Message of an earlier failed installation. */
  failed: z.string().nullable(),
});
export type Update = z.infer<typeof updateSchema>;

export const updaterStatusSchema = z.object({
  updater: z.string(),
  mode: z.enum(["host", "platform", "off"]),
  channel: updateChannelSchema,
  /** Why admins cannot switch the channel; null: they can. */
  channelLocked: z.string().nullable(),
  installed: z.string().nullable(),
  available: updateSchema.nullable(),
  /** Needs upgrade steps; Stable only. */
  attention: updateSchema.nullable(),
  installing: z
    .object({
      version: z.string(),
      startedAt: z.string(),
      manual: z.boolean(),
      stage: z.enum(INSTALL_STAGES),
    })
    .nullable(),
  last: z
    .object({
      version: z.string(),
      result: z.enum(INSTALL_RESULTS),
      /** Why it failed, for admins. */
      message: z.string().nullable(),
      finishedAt: z.string(),
    })
    .nullable(),
  checking: z.boolean(),
  /** Last successful check. */
  checkedAt: z.string().nullable(),
  /** The last check's error. */
  error: z.string().nullable(),
  automatic: z.boolean(),
  /** e.g. "3d"; null: none. */
  cooldown: z.string().nullable(),
  /** e.g. "02:00-05:00". */
  window: z.string().nullable(),
  timezone: z.string(),
});
export type UpdaterStatus = z.infer<typeof updaterStatusSchema>;

/** The answer of every `/updates` route. */
export type UpdatesResponse = {
  /** APP_VERSION; null in development. */
  app: { version: string | null };
  /** False: no updater at UPDATER_URL. */
  reachable: boolean;
  updater: UpdaterStatus | null;
  /** Why the updater refused or could not be reached. */
  error: string | null;
};

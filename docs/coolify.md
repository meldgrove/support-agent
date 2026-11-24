# Coolify

For the person who runs the support agent on [Coolify](https://coolify.io)
instead of on a Linux server of its own. Coolify uses
`compose.coolify.yaml`: the services of `compose.yaml`, without a host port,
pulling the images at every deploy, and with an `updater` that calls
Coolify's deploy link. Requirements, sign-in, health checks, the update
button, backups, logs and hardening are the same as on a server: see
[Deployment](deployment.md). Every environment variable is described in
[Configuration](configuration.md).

## Setup

1. **Database:** create a PostgreSQL resource (16 or later) and copy its
   internal URL.
2. **Application:** create a Docker Compose resource from the public
   repository `https://github.com/meldgrove/support-agent`, branch `stable`,
   Docker Compose location `/compose.coolify.yaml`. Under Advanced, set Auto
   deploy to "Manual deployments only", so that only releases deploy, and
   turn on "Connect To Predefined Network", so that the app reaches the
   database.
3. **Domain:** assign the domain, such as `https://support.example.org`, to
   `web`, port 3000. `bot` needs none.
4. **Register the app at your provider** with the redirect URL
   `<APP_URL>/api/auth/callback/oidc` ([Sign-in](deployment.md#sign-in)).
5. **Environment variables** of the resource: `SUPPORT_AGENT_VERSION` (a
   series such as `0.1`, see [Automatic updates](#automatic-updates)),
   `APP_URL` (the domain), `DATABASE_URL` (the database's internal URL), new
   secrets (`openssl rand -base64 32` for `AUTH_SECRET` and
   `ENCRYPTION_KEY`), an `UPDATER_TOKEN` (`openssl rand -hex 32`,
   recommended: [it protects the update
   service](#protect-the-update-service)), the `OIDC_*` values and your
   address in `ADMIN_EMAILS`.
6. **Deploy**, open `APP_URL` and sign in with an address from
   `ADMIN_EMAILS`.
7. **Continue in the admin interface:** the overview page lists the steps
   (Slack, a provider, a knowledge source, an agent). They can also be
   taken in a terminal instead:
   [Settings from the command line](#settings-from-the-command-line).
8. **Automatic updates:** set them up as [below](#automatic-updates).

## Settings from the command line

In the resource, open **Terminal**, choose the `web` container and run
`cli settings list`. `cli settings apply <name>` saves a JSON body from
stdin, as the admin page does: paste the body (the terminal does not show
it), then press Ctrl-D. For a list (`providers`, `knowledge-sources`,
`agents`), `apply` without `--id` adds an entry and prints its ID. The
commands, the setting names and an example body for each are in
[Deployment](deployment.md#settings-from-the-command-line).

## Upgrades

1. Read the release notes. Releases with **Upgrade steps needed** start a
   new series and list what to do.
2. Take the steps, then change `SUPPORT_AGENT_VERSION` in the resource's
   environment variables to the new series and redeploy. Coolify reads
   `compose.coolify.yaml` from `stable`, which is at the newest release.

## Backups

For [Meldgrove Backups](deployment.md#backups), set `BACKUP_URL` and
`BACKUP_TOKEN` (from the app's source in Backups) in the resource's
environment variables and redeploy. Each deploy pulls the backup agent's
image.

## Automatic updates

The image tag set in `SUPPORT_AGENT_VERSION` decides what installs: a series
such as `0.1` gets every release that needs no steps, `latest` every
release, also those with upgrade steps, and `preview` every preview (the
unstable channel). Admins cannot switch the channel in the app; for a
release with upgrade steps, the update button says to take the steps and
change the tag instead. `UPDATE_COOLDOWN`, `UPDATE_WINDOW` and `TZ` work as
on a server ([Automatic updates](deployment.md#automatic-updates)). Set up
backups first: migrations run without anyone watching.

1. Under Settings > Advanced, turn on API Access if it is off.
2. Under Keys & Tokens > API Tokens, create a token with only the `deploy`
   permission; clear `read`. Coolify shows it only once.
3. In the support agent's resource, select Webhooks and copy Deploy Webhook.
4. In the resource's environment variables, set `UPDATE_DEPLOY_HOOK_URL` to
   the webhook and `UPDATE_DEPLOY_HOOK_TOKEN` to the token, then redeploy.

The `updater` log then names the tag it watches.

### Protect the update service

With `UPDATER_TOKEN` set, the app sends it with each request to the updater,
and the updater refuses requests without it. Recommended for resources set
up before it existed; without it, everything works as before. Until it is
done, **Settings → Updates** warns that the update service takes requests
without a token (with updater 0.2.4 or later, which reports it). Do it once
the tag in `SUPPORT_AGENT_VERSION` gives the release whose notes name this
step, or a newer one: each deploy pulls that tag, and an older version does
not send the token, so its update button would get no answer. In the
resource's environment variables, set `UPDATER_TOKEN` to the output of
`openssl rand -hex 32`, then redeploy: Coolify reads `compose.coolify.yaml`
from `stable` and pulls the images again.

## Moving an existing resource

Resources set up before `compose.coolify.yaml` existed read
`/compose.yaml`. That file is made for a server now: it has no deploy link
and does not pull the images again, so automatic updates stop with it. Once
the release that brings `compose.coolify.yaml` is out (its release notes
name this step):

1. In the resource's configuration, set Docker Compose Location to
   `/compose.coolify.yaml` and save.
2. Keep the environment variables. Change `SUPPORT_AGENT_VERSION` when the
   release starts a new series.
3. Redeploy. The services and volumes keep their names, so the data stays.

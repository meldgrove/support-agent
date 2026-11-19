# Deployment

For the person who runs the support agent on a server: requirements, the
setup on [Coolify](#coolify) or on a [Debian server](#debian), sign-in,
upgrades, automatic updates, backups and troubleshooting. Every environment
variable is described in [Configuration](configuration.md); setting up
Slack, models and agents happens afterwards in the admin interface
([Admin guide](admin-guide.md)).

## Requirements

- **Coolify, or a server with Debian 12 or later** (or a similar system with
  systemd and apt, such as Ubuntu 24.04), with Docker Engine and its Compose
  plugin.
- **PostgreSQL 16 or later**, the only stateful dependency.
- **A reverse proxy that terminates HTTPS** for the admin interface:
  Coolify's own, or Caddy on Debian. The bot needs no public address: it
  opens an outgoing connection to Slack.
- **An OpenID Connect provider** for sign-in: Keycloak, Microsoft Entra ID,
  Google, or "Sign in with Slack".
- Outgoing HTTPS to Slack, to the model providers and to the knowledge
  sources.

## What runs

Each [release](https://github.com/meldgrove/support-agent/releases)
publishes the image `ghcr.io/meldgrove/support-agent` for linux/amd64 and
linux/arm64, tagged with its version (`0.1.0`), its series (`0.1`; from 1.0.0
the major version, `1`) and `latest`. A release that needs manual steps
starts a new series, so the releases within a series install without anyone
acting. Every change on `main` that passed its checks is published as a
preview too: `0.1.1-preview.3` (three changes after 0.1.0) and `preview`.

| File                    | Contains                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `Dockerfile`            | The image. Its command (`all`, `web`, `bot`, `migrate`) picks the role.                             |
| `compose.yaml`          | A one-off `migrate`, the admin interface (`web`), the Slack bot (`bot`) and the optional `updater`. |
| `compose.postgres.yaml` | Adds a PostgreSQL 18 container, for servers without a database of their own.                        |

The image runs as an unprivileged user (uid 1000). `web` listens on port
3000, published on `127.0.0.1:3000` for a reverse proxy on the same machine.
When another service holds that port (Docker reports `port is already
allocated`), set `SUPPORT_AGENT_PORT` to a free one. A platform with its own
proxy, such as Coolify, reaches `web` through the Docker network and does not
use this port, so any free port will do. The branch `stable` is at the newest
release; `main` has changes that are not released yet.

### One container

Platforms that run a single image (no Compose) can use the command `all`
with `RUN_MIGRATIONS=true`: the admin interface and the bot then share one
process. Separate `web` and `bot` containers are more robust: the bot keeps
answering while the admin interface is redeployed.

## Coolify

1. **Database:** create a PostgreSQL resource (16 or later) and copy its
   internal URL.
2. **Application:** create a Docker Compose resource from the public
   repository `https://github.com/meldgrove/support-agent`, branch `stable`,
   Docker Compose location `/compose.yaml`. Under Advanced, set Auto deploy
   to "Manual deployments only", so that only releases deploy, and turn on
   "Connect To Predefined Network", so that the app reaches the database.
3. **Domain:** assign the domain, such as `https://support.example.org`, to
   `web`, port 3000. `bot` needs none.
4. **Register the app at your provider** with the redirect URL
   `<APP_URL>/api/auth/callback/oidc` ([Sign-in](#sign-in)).
5. **Environment variables** of the resource: `SUPPORT_AGENT_VERSION` (a
   series such as `0.1`, see [Automatic updates](#automatic-updates)),
   `APP_URL` (the domain), `DATABASE_URL` (the database's internal URL), new
   secrets (`openssl rand -base64 32` for `AUTH_SECRET` and
   `ENCRYPTION_KEY`), the `OIDC_*` values and your address in
   `ADMIN_EMAILS`.
6. **Deploy**, open `APP_URL` and sign in with an address from
   `ADMIN_EMAILS`.
7. **Continue in the admin interface:** the overview page lists the steps
   (Slack, a provider, a knowledge source, an agent).
8. **Automatic updates:** set them up [on Coolify](#on-coolify).

## Debian

On a server with Debian 12 or later, or a similar system such as Ubuntu,
run the commands as root (`sudo -i`).

1. **Docker:** install Docker Engine and the Compose plugin from Docker's
   apt repository ([Debian](https://docs.docker.com/engine/install/debian/),
   [Ubuntu](https://docs.docker.com/engine/install/ubuntu/)), and Git:
   `apt install git`.
2. **Get the files** at the newest release:

   ```sh
   git clone --branch stable https://github.com/meldgrove/support-agent.git /srv/support-agent
   cd /srv/support-agent
   ```

3. **Register the app at your provider** with the redirect URL
   `<APP_URL>/api/auth/callback/oidc` ([Sign-in](#sign-in)).
4. **Create `.env`** from `.env.example` (`cp .env.example .env`,
   `chmod 600 .env`) and set production values: `SUPPORT_AGENT_VERSION` (the
   newest release, such as `0.1.0`), `APP_URL`, `DATABASE_URL`, new secrets
   (`openssl rand -base64 32` for `AUTH_SECRET` and `ENCRYPTION_KEY`), the
   `OIDC_*` values and your address in `ADMIN_EMAILS`. Remove
   `NODE_ENV=development` and `RUN_MIGRATIONS`. Without a database of your
   own, add `COMPOSE_FILE=compose.yaml:compose.postgres.yaml`, a
   `POSTGRES_PASSWORD` (`openssl rand -hex 32`) and
   `DATABASE_URL=postgres://support_agent:<POSTGRES_PASSWORD>@postgres:5432/support_agent`.
5. **Start:** `docker compose up -d --pull always`.
6. **HTTPS:** point the domain's DNS at the server, install Caddy
   (`apt install caddy`), and replace `/etc/caddy/Caddyfile` with:

   ```text
   support.example.org {
   	reverse_proxy 127.0.0.1:3000
   }
   ```

   Then `systemctl reload caddy`. Caddy gets the certificate itself. With
   `SUPPORT_AGENT_PORT` set, use that port instead of 3000.

7. Open `APP_URL` and sign in with an address from `ADMIN_EMAILS`.
8. **Continue in the admin interface:** the overview page lists the steps
   (Slack, a provider, a knowledge source, an agent).
9. **Automatic updates:** set them up [on Debian](#on-debian).

## Sign-in

The admin interface signs people in through one OpenID Connect provider.
Register a client there with this redirect URL:

```
<APP_URL>/api/auth/callback/oidc
```

and set `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`. The
provider must return the email address (scopes `openid email profile`).

| Provider           | `OIDC_ISSUER`                                        | Notes                                                                                                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keycloak           | `https://<host>/realms/<realm>`                      | Confidential client, standard flow.                                                                                                                                                                                                                        |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` | App registration, web platform, a client secret.                                                                                                                                                                                                           |
| Google             | `https://accounts.google.com`                        | OAuth client of type "Web application".                                                                                                                                                                                                                    |
| Slack              | `https://slack.com`                                  | The support agent's own Slack app works: its manifest already lists the redirect URL and the `openid email profile` user scopes. Use the app's Client ID and Client Secret (Basic Information). If sign-in fails at the token step, set `OIDC_PKCE=false`. |

Nobody can sign up. People sign in once an admin added their email address
(Users page), and the addresses in `ADMIN_EMAILS` are always active admins.
Keep at least one address there: it is the way back in when every admin
account is gone.

The support agent trusts the provider's email address: whoever signs in at
the provider with an address on the list gets that person's access. Use your
organization's own provider, where people cannot choose or change their
address themselves (no open self-registration). When the provider says an
address is not verified (`email_verified: false`), sign-in fails.

## Health checks

- `GET /-/livez`: the admin interface process runs.
- `GET /-/readyz`: it reaches the database.
- The bot touches `/tmp/bot-heartbeat` every 30 seconds while it is
  connected to Slack (or Slack is not set up yet); `compose.yaml` checks its
  age. The overview page of the admin interface shows the bot's state too.

When Slack stays unreachable for `BOT_WATCHDOG_SECONDS` (default five
minutes), the bot exits; `restart: unless-stopped` starts a fresh one. Keep a
restart policy on the bot container.

## Upgrades

1. Read the release notes. Releases with **Upgrade steps needed** start a
   new series and list what to do.
2. Take the steps, then move to the new series:
   - **Coolify:** change `SUPPORT_AGENT_VERSION` in the resource's
     environment variables and redeploy. Coolify reads `compose.yaml` from
     `stable`, which is at the newest release.
   - **Debian:** in `/srv/support-agent`, run `git pull` (the newest
     release's `compose.yaml`), then either **Install anyway…** under the
     [update button](#update-button), or change `SUPPORT_AGENT_VERSION` in
     `.env` and run `docker compose up -d --pull always`.

The `migrate` service applies database migrations before `web` and `bot`
start.

## Automatic updates

The `updater` service of `compose.yaml`
([meldgrove/updater](https://github.com/meldgrove/updater)) looks for new
versions every hour and installs them. Set up [backups](#backups) first:
migrations run without anyone watching. There are two channels:

- **Stable** (default): releases. A release that needs no steps installs
  once it has been out for three days (`UPDATE_COOLDOWN`: `12h`, `30m`, `0`
  for within the hour), and with `UPDATE_WINDOW` (such as `02:00-05:00`, in
  the time zone `TZ`) only then. A release with upgrade steps (a new series)
  is shown to admins but never installs by itself.
- **Preview** (unstable): every change on `main` as soon as its checks
  passed, before it is released, and every release. Previews install within
  the hour (inside the window, if set) and have no release notes. New
  features first, and now and then a new bug. Switching back to Stable never
  goes back to an older version: the preview stays until a release is newer.

### Update button

Admins see an update icon in the header of the admin interface. It checks
for updates on click, lists the changes of an available update with a link
to its release notes, installs it on request (**Install now**), shows the
progress, and says why an installation failed. The page reloads once the
server reports the new version as running. A release with upgrade steps
installs only with **Install anyway…**: take the steps first. Where the
image tag set on the platform decides (Coolify), the button says to take the
steps and change that tag instead. With automatic updates off on the server,
the button still shows new releases, but nothing installs from the app.
**Settings → Updates** shows the installed version, the channel (on Debian,
admins choose it there) and when updates install by themselves.

Without the `updater` service, the button says that there is no update
service; `UPDATER_URL` ([Configuration](configuration.md#updates)) points
the app to it.

### On Coolify

The image tag set in `SUPPORT_AGENT_VERSION` decides what installs: a series
such as `0.1` gets every release that needs no steps, `latest` every
release, also those with upgrade steps, and `preview` every preview (the
unstable channel). Admins cannot switch the channel in the app.

1. Under Settings > Advanced, turn on API Access if it is off.
2. Under Keys & Tokens > API Tokens, create a token with only the `deploy`
   permission; clear `read`. Coolify shows it only once.
3. In the support agent's resource, select Webhooks and copy Deploy Webhook.
4. In the resource's environment variables, set `UPDATE_DEPLOY_HOOK_URL` to
   the webhook and `UPDATE_DEPLOY_HOOK_TOKEN` to the token, then redeploy.

The `updater` log then names the tag it watches.

### On Debian

The server installs the version the updater asks for: it writes it into
`SUPPORT_AGENT_VERSION` in `.env`, pulls the image, runs the migrations,
starts the new version and waits until it is healthy. When it does not
become healthy, the server restores `.env` and starts the version before,
and the button says why. As root in `/srv/support-agent`, with
`UPDATE_DEPLOY_HOOK_URL` empty:

```sh
docker compose up -d --pull always
docker compose run --rm -T --pull always updater host-setup > updater-setup.sh
sh updater-setup.sh
```

The second command writes the setup script from the updater's image; read
it before you run it. The script installs a systemd unit that waits for the
updater's request and deploys it.
`journalctl -u meldgrove-updater-support-agent.service` shows each
installation; `sh updater-setup.sh remove` switches it off.

The server installs images, not files: when a release changes
`compose.yaml`, run `git pull` (branch `stable`) and `docker compose up -d`.

**Installations set up before the update button** (updater 0.1) get it in
three steps, as root in `/srv/support-agent`:

1. Run `git pull` (branch `stable`) for the newest `compose.yaml`.
2. Set `SUPPORT_AGENT_VERSION` in `.env` to the release that brings the
   update button, or a newer one, and run `docker compose up -d --pull always`.
   This installs the app with the button, not only the new `updater`.
3. Run the host setup again:

   ```sh
   docker compose run --rm -T --pull always updater host-setup > updater-setup.sh
   sh updater-setup.sh
   ```

Until the host setup runs again, the updater follows the tag in
`SUPPORT_AGENT_VERSION` as before, and the settings say that choosing the
channel needs it.

## Backups

Back up the PostgreSQL database (`pg_dump`, or the `postgres` volume) and
keep `ENCRYPTION_KEY` separately. Without the key the database still works,
but every stored API key and token must be entered again.

## Logs

Both processes log JSON lines to standard output (`docker compose logs bot`).
Logs carry identifiers (agent, channel, error codes), never message texts or
keys. With `SENTRY_DSN`, errors also become error reports.

Useful lines from the bot: `connected to Slack`, `disconnected from Slack`,
`could not connect to Slack` (with the Slack error code),
`main model failed; trying the fallback model`, and `Slack unreachable for too
long; exiting so the process restarts`.

## Hardening

- Serve the admin interface over HTTPS only. It holds the API keys.
- Keep the admin interface reachable only where needed (for example on a
  VPN or behind the proxy's access rules); the bot does not need it.
- Give each knowledge source credentials that read only what its agents may
  answer from ([Knowledge sources](knowledge-sources.md)).
- Choose model providers your organization allows for the content of
  support questions: the question, the thread and the passages found go to
  the provider.
- Set the retention period of message texts in Settings (default 90 days).

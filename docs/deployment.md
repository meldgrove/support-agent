# Deployment

For the person who runs the support agent on a server: requirements, a
setup with Docker Compose, sign-in, upgrades, backups and troubleshooting.
Every environment variable is described in [Configuration](configuration.md);
setting up Slack, models and agents happens afterwards in the admin
interface ([Admin guide](admin-guide.md)).

## Requirements

- **PostgreSQL 16 or later**, the only stateful dependency.
- **Docker with Docker Compose.** Without Docker you need Node.js 26.
- **A reverse proxy that terminates HTTPS** for the admin interface. The bot
  needs no public address: it opens an outgoing connection to Slack.
- **An OpenID Connect provider** for sign-in: Keycloak, Microsoft Entra ID,
  Google, or "Sign in with Slack".
- Outgoing HTTPS to Slack, to the model providers and to the knowledge
  sources.

## Setup with Docker Compose

Each [release](https://github.com/meldgrove/support-agent/releases)
publishes the image `ghcr.io/meldgrove/support-agent` for linux/amd64 and
linux/arm64, tagged with its version (`0.1.0`), its series (`0.1`; from 1.0.0
the major version, `1`) and `latest`. A release that needs manual steps
starts a new series, so the releases within a series install without anyone
acting.

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
use this port, so any free port will do.

1. **Get the files:** clone the repository and check out the release, e.g.
   `git checkout v0.1.0`. Platforms that read `compose.yaml` from the
   repository follow the branch `stable`, which is at the newest release.
2. **Create `.env`** next to `compose.yaml` from `.env.example` and set
   production values: `SUPPORT_AGENT_VERSION`, `APP_URL`, `DATABASE_URL`, new
   secrets (`openssl rand -base64 32` for `AUTH_SECRET` and
   `ENCRYPTION_KEY`), the `OIDC_*` values ([Sign-in](#sign-in)) and your
   address in `ADMIN_EMAILS`. Remove `NODE_ENV=development` and
   `RUN_MIGRATIONS`.
3. **Start:** `docker compose up -d` (with `-f compose.yaml -f
compose.postgres.yaml` and `POSTGRES_PASSWORD` for the bundled database).
4. **Point the reverse proxy** at `127.0.0.1:3000`, open `APP_URL` and sign
   in with an address from `ADMIN_EMAILS`.
5. **Continue in the admin interface:** the overview page lists the steps
   (Slack, a provider, a knowledge source, an agent).

### One container

Platforms that run a single image (no Compose) can use the command `all`
with `RUN_MIGRATIONS=true`: the admin interface and the bot then share one
process. Separate `web` and `bot` containers are more robust: the bot keeps
answering while the admin interface is redeployed.

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
2. Change `SUPPORT_AGENT_VERSION` (or let the updater do it, below) and run
   `docker compose up -d`. The `migrate` service applies database migrations
   before `web` and `bot` start.

### Automatic updates

The optional `updater` service redeploys when the tag in
`SUPPORT_AGENT_VERSION` points to a new image. It needs the platform's deploy
link in `UPDATE_DEPLOY_HOOK_URL` (and `UPDATE_DEPLOY_HOOK_TOKEN` when the
link needs a bearer token); without it, it does nothing. Use a series tag
such as `0.1` to get every release that installs without steps.
`UPDATE_COOLDOWN` (default `3d`) lets a release settle before it installs;
`UPDATE_WINDOW` (e.g. `02:00-05:00`, time zone `TZ`) limits when. See
[meldgrove/updater](https://github.com/meldgrove/updater).

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

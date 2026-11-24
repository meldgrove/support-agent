# Deployment

For the person who runs the support agent on a Linux server, such as a VPS
with Debian or Ubuntu: requirements, [setup](#setup),
[settings from the command line](#settings-from-the-command-line), sign-in,
upgrades, automatic updates, backups and troubleshooting. To run it on
Coolify instead, see [Coolify](coolify.md). Every environment variable is
described in [Configuration](configuration.md); setting up Slack, models and
agents happens afterwards in the admin interface
([Admin guide](admin-guide.md)) or on the server with `cli settings`.

## Requirements

- **A server with Debian 12 or later** (or a similar system with systemd and
  apt, such as Ubuntu 24.04), with Docker Engine and its Compose plugin, and
  a domain name that points at it.
- **PostgreSQL 16 or later**, the only stateful dependency: a database of
  your own, or the one `compose.postgres.yaml` adds.
- **Caddy** (or another reverse proxy on the server) that terminates HTTPS
  for the admin interface. The bot needs no public address: it opens an
  outgoing connection to Slack.
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
| `Dockerfile`            | The image. Its command (`all`, `web`, `bot`, `migrate`, `cli`) picks the role.                      |
| `compose.yaml`          | A one-off `migrate`, the admin interface (`web`), the Slack bot (`bot`) and the optional `updater`. |
| `compose.postgres.yaml` | Adds a PostgreSQL 18 container, for servers without a database of their own.                        |
| `compose.coolify.yaml`  | The same as `compose.yaml`, for [Coolify](coolify.md).                                              |

The image runs as an unprivileged user (uid 1000). `web` listens on port
3000, published on `127.0.0.1:3000` for a reverse proxy on the same machine.
When another service holds that port (Docker reports `port is already
allocated`), set `SUPPORT_AGENT_PORT` to a free one. With several apps on
one server, give each its own port and its own site in the Caddyfile. The
branch `stable` is at the newest release; `main` has changes that are not
released yet.

### One container

Platforms that run a single image (no Compose) can use the command `all`
with `RUN_MIGRATIONS=true`: the admin interface and the bot then share one
process. Separate `web` and `bot` containers are more robust: the bot keeps
answering while the admin interface is redeployed.

## Setup

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
   (`openssl rand -base64 32` for `AUTH_SECRET` and `ENCRYPTION_KEY`), an
   `UPDATER_TOKEN` (`openssl rand -hex 32`, recommended: [it protects the
   update service](#protect-the-update-service)), the `OIDC_*` values and
   your address in `ADMIN_EMAILS`. Remove
   `NODE_ENV=development` and `RUN_MIGRATIONS`. Without a database of your
   own, add `COMPOSE_FILE=compose.yaml:compose.postgres.yaml`, a
   `POSTGRES_PASSWORD` (`openssl rand -hex 32`) and
   `DATABASE_URL=postgres://support_agent:<POSTGRES_PASSWORD>@postgres:5432/support_agent`.
5. **Start:** `docker compose up -d --pull always`.
6. **HTTPS:** point the domain's DNS at the server, install Caddy
   (`apt install caddy`), and put this site into `/etc/caddy/Caddyfile`, in
   place of the package's example site `:80` and next to the sites of other
   apps:

   ```text
   support.example.org {
   	reverse_proxy 127.0.0.1:3000
   }
   ```

   Then `systemctl reload caddy`. Caddy gets the certificate itself. With
   `SUPPORT_AGENT_PORT` set, use that port instead of 3000.

7. Open `APP_URL` and sign in with an address from `ADMIN_EMAILS`.
8. **Continue in the admin interface:** the overview page lists the steps
   (Slack, a provider, a knowledge source, an agent). They can also be
   taken on the server instead:
   [Settings from the command line](#settings-from-the-command-line).
9. **Automatic updates:** [set them up](#setup-on-the-server).

## Settings from the command line

What admins set in the admin interface (providers, knowledge sources,
Slack, agents and the Settings page) can also be set on the server, without
a browser, with `cli settings`. It runs the same code as the pages: the same
checks, the same encryption, the same reload of the bot, and an entry in the
audit log with the actor `operator` and the command. In `/srv/support-agent`:

```sh
docker compose run --rm -T migrate cli settings list
```

In a running container, such as a terminal on Coolify, the command is just
`cli …` (`docker compose exec web cli settings list`).

| Command                                                        | What it does                                                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `cli settings list [--json]`                                   | Each setting and each entry of a list with its ID: `set`, `not set` or `incomplete`, and hints |
| `cli settings show <name> [--id <id>]`                         | The setting, a whole list or one entry as JSON, as the page reads it: keys only as hints       |
| `cli settings apply <name>`                                    | Saves the JSON body on stdin, as the page's **Save** does; for a list, adds an entry           |
| `cli settings apply <name> --id <id>`                          | Saves the body of the entry's edit form                                                        |
| `cli settings remove <name> --id <id>`                         | Deletes an entry, as the page's **Delete** does                                                |
| `cli settings test providers --id <id> --model <model>`        | The provider's **Test**: a short call to the model                                             |
| `cli settings test knowledge-sources --id <id> --query <text>` | The source's **Test**: a search                                                                |
| `cli settings test slack`                                      | **Check connection**                                                                           |
| `cli settings show providers --id <id> --models`               | The models the provider lists                                                                  |
| `cli settings show slack --channels`                           | The channels the bot can see, with their IDs                                                   |
| `cli settings show slack --manifest [--name <app name>]`       | The manifest for a new Slack app                                                               |
| `cli help`                                                     | The commands and the setting names                                                             |

The settings: `providers`, `knowledge-sources` and `agents` are lists;
`slack` and `app` (the **Settings** page) exist once.

- Secrets go only in the body on stdin, never in an argument (arguments show
  in `ps` and the shell history). Nothing prints a saved key or token.
- `apply` without `--id` adds an entry: it prints `Created. ID: …` on stderr
  and the new entry as JSON on stdout.
- For `providers`, `knowledge-sources` and `slack`, fields left out of the
  body stay as they are, as on the page; a key or token in the body
  replaces the saved one. `agents` and `app` take the whole body, as the page
  sends it: start from what `show` prints. An agent's body also needs the
  `version` that `show` printed; when the agent changed in between, the
  command refuses, as the page does.
- Exit codes: `0` done; `1` refused, with the page's message and the field
  on stderr (a failed test prints its result too); `2` a wrong command or a
  body that is not JSON.
- The support agent issues no tokens for other apps, so there is no
  `cli tokens`. Users stay on the **Users** page.

The bodies, as the pages send them:

`providers`, a new provider (`kind`: `anthropic`, `openai`, `mistral` or
`openai_compatible`; the last one needs a `baseUrl`, and its `apiKey` is
optional):

```json
{ "name": "Anthropic", "kind": "anthropic", "apiKey": "<API key>" }
```

`providers --id <id>`, a new key for a provider (or a new `name` or
`baseUrl`):

```json
{ "apiKey": "<API key>" }
```

`knowledge-sources`, a search API with a bearer token (`auth`: `none`,
`bearer` or `oauth2_client_credentials` with `tokenUrl`, `clientId` and
`scope`; `secret` is the token or the client secret). The fields of
`config` are described in [Knowledge sources](knowledge-sources.md).

```json
{
  "name": "IT handbook",
  "description": "Public IT articles",
  "kind": "search_api",
  "config": {
    "url": "https://search.example.org/search",
    "auth": "bearer",
    "tokenUrl": null,
    "clientId": null,
    "scope": null,
    "bodyTemplate": "{\"query\": \"{{query}}\", \"limit\": \"{{limit}}\"}",
    "resultsPath": "results",
    "titlePath": "title",
    "urlPath": "url",
    "textPath": "text",
    "sectionPath": null,
    "maxResults": 6
  },
  "secret": "<bearer token>"
}
```

`slack`: the bot token (`xoxb-…`), the app-level token (`xapp-…`) and the
optional alert channel, an ID from `cli settings show slack --channels`
(`null` turns the alerts off). Create the Slack app with the manifest of
`cli settings show slack --manifest` first ([Admin guide](admin-guide.md#1-connect-slack)).

```json
{ "botToken": "<bot token>", "appToken": "<app-level token>", "alertChannelId": "C0123456789" }
```

`agents`, a new agent: the provider's and the sources' IDs from
`cli settings list`, and Slack channel IDs. With `"enabled": true`, it
needs a provider, a model and a channel.

```json
{
  "name": "IT support",
  "enabled": true,
  "instructions": "You are the IT support assistant of our organization in this Slack channel.",
  "providerId": "<provider ID>",
  "model": "claude-sonnet-5-5",
  "fallbackProviderId": null,
  "fallbackModel": null,
  "replyMode": "questions",
  "followUpsInThreads": true,
  "noAnswerMode": "escalate",
  "escalationMessage": "I don't know. Please ask the IT team in #it.",
  "headlineThreads": false,
  "headlineMessage": "",
  "displayName": null,
  "iconUrl": null,
  "readImages": true,
  "channels": ["C0123456789"],
  "knowledgeSourceIds": ["<knowledge source ID>"]
}
```

`app`, the **Settings** page (`retentionDays`: `0` keeps no texts;
`workingReaction`: an emoji name, or `null`):

```json
{
  "retentionDays": 90,
  "errorMessage": "Sorry, I can't answer right now. Someone from the team will get back to you.",
  "workingReaction": "eyes"
}
```

Then test it: `cli settings test slack`,
`cli settings test providers --id <id> --model claude-sonnet-5-5`, or
`cli settings test knowledge-sources --id <id> --query "reset my password"`.
Agent tests and the test console stay in the admin interface.

An AI with access to the server sets a key this way: it receives the secret
as a file, pipes the body into `cli settings apply`, runs
`cli settings test` and deletes the file. With `jq`, the secret never
appears in an argument:

```sh
jq -n --rawfile key anthropic-key '{name: "Anthropic", kind: "anthropic", apiKey: ($key | rtrimstr("\n"))}' \
  | docker compose run --rm -T migrate cli settings apply providers
docker compose run --rm -T migrate cli settings test providers --id <id> --model claude-sonnet-5-5
rm anthropic-key
```

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
2. Take the steps, then move to the new series: in `/srv/support-agent`, run
   `git pull` (the newest release's `compose.yaml`), then either
   **Install anyway…** under the [update button](#update-button), or change
   `SUPPORT_AGENT_VERSION` in `.env` and run
   `docker compose up -d --pull always`.

The `migrate` service applies database migrations before `web` and `bot`
start.

## Automatic updates

The `updater` service of `compose.yaml`
([meldgrove/updater](https://github.com/meldgrove/updater)) looks for new
versions every hour and installs them once the
[host setup](#setup-on-the-server) runs. Set up [backups](#backups) first:
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
installs only with **Install anyway…**: take the steps first. With automatic
updates off on the server, the button still shows new releases, but nothing
installs from the app. **Settings → Updates** shows the installed version,
the channel (admins choose it there) and when updates install by
themselves.

Without the `updater` service, the button says that there is no update
service; `UPDATER_URL` ([Configuration](configuration.md#updates)) points
the app to it. Only the app reaches the updater's API; never publish its
port. With `UPDATER_TOKEN` set, the app sends it with each request and the
updater refuses requests without it; without it, anything that reaches the
updater on the Docker network could install an offered update or switch the
channel.

### Setup on the server

The server installs the version the updater asks for: it writes it into
`SUPPORT_AGENT_VERSION` in `.env`, pulls the image, runs the migrations,
starts the new version and waits until it is healthy. When it does not
become healthy, the server restores `.env` and starts the version before,
and the button says why. As root in `/srv/support-agent`:

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

### Protect the update service

Recommended for installations set up before `UPDATER_TOKEN` existed;
without it, everything works as before. Until it is done, **Settings →
Updates** warns that the update service takes requests without a token
(with updater 0.2.4 or later, which reports it). Do it once the support
agent runs the release whose notes name this step, or a newer one
(**Settings → Updates** shows the installed version): an older version does
not send the token, and its update button would get no answer from the
updater. As root in `/srv/support-agent`:

```sh
git pull
# in .env: UPDATER_TOKEN=<the output of: openssl rand -hex 32>
docker compose up -d --pull always
```

`git pull` brings the `compose.yaml` that passes the token to the app and to
the updater (as `API_TOKEN`); `--pull always` makes sure the updater is one
that checks it. Then the updater answers only the app.

## Backups

### With Meldgrove Backups

The `backup-agent` service in `compose.yaml` sends the database to
[Meldgrove Backups](https://github.com/meldgrove/backups) when Backups asks.
While `BACKUP_URL` is empty, it idles.

1. In Backups, add a source of the kind **Meldgrove app**, and put the two
   lines it shows (`BACKUP_URL`, `BACKUP_TOKEN`) into `.env`.
2. Run `docker compose up -d`, then check the agent:
   `docker compose exec backup-agent backup-agent check`.
3. Let the backup end before the update window (`UPDATE_WINDOW`): automatic
   updates run migrations without anyone present.

Keep `ENCRYPTION_KEY` apart from the backups: a restore needs it, the backups
do not hold it, and Backups shows the name on the source page.

With [automatic updates](#automatic-updates), run the updater's host setup
again once the app's folder has updater 0.2.2 or later (`git pull`): its
deploy script then pulls the agent's image with each update. Without it:
`docker compose pull backup-agent && docker compose up -d`.

To restore, follow the
[agent's guide](https://github.com/meldgrove/backup-agent#restore). Support
Agent's services are `web` and `bot`: stop both
(`docker compose stop web bot`) where the guide stops `web worker`.

### By hand

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

# Contributing

Thanks for helping. This guide covers the development setup, the checks a
change must pass, and how releases work. `AGENTS.md` has the code rules;
`docs/architecture.md` explains how the parts fit together.

## Development setup

You need Node.js 26 and Docker.

```sh
docker compose -f compose.dev.yaml up -d   # PostgreSQL 18 and a Keycloak for sign-in
cp .env.example .env.local
npm ci
npm run dev
```

Open http://localhost:5173 and sign in with `ada@example.org`, password
`support-agent-dev` (an admin through `ADMIN_EMAILS`). The Keycloak admin
console is at http://localhost:8096 (admin / admin).

`npm run dev` starts the Vite dev server for the admin app and the server
with `APP_ROLE=all`, so the Slack bot runs too. It stays idle until you
connect a Slack app in the admin interface; use a test workspace and a
separate Slack app for development.

`npm run cli -- settings list` runs the operator command against the
development database (`cli help` lists the commands).

## Checks

```sh
npm run lint
npm run format:check      # npm run format fixes it
npm run typecheck
npm test                  # unit tests
npm run test:integration  # needs the PostgreSQL of compose.dev.yaml
npm run build
```

CI runs all of them, checks that the migrations match the schema, audits the
production dependencies, builds the Docker image, and starts it with the
compose files of the newest release (branch `stable`), as servers that have
not pulled yet run it (`.github/compose-compat.env` holds fake settings).

## Database changes

Edit `apps/server/src/db/schema/`, run `npm run db:generate`, and commit the
generated migration in `apps/server/drizzle/`. Migrations run before the new
version starts (`migrate` service), so they must work while the old version
still runs for a moment: add columns with defaults, don't rename in place.

## Tests

Unit tests sit next to the code (`*.test.ts`). Integration tests
(`*.int.test.ts`) get a fresh database (`TEST_DATABASE_URL`, default
`support_agent_test` on the development PostgreSQL). Tests never call real
model providers or Slack: use `setLlmClientFactoryForTests` and stub
`fetch`.

## Pull requests

Write the title as a release-note line. Label a pull request `breaking`
when the people who run the support agent must act on upgrade, and describe
the steps in it. Update the docs when behavior or configuration changes.

## Releases

A release bundles everything merged to `main` since the previous one.
Maintainers start it by hand with **Actions → Release → Run workflow**
(the shared Meldgrove release workflow): it tags the next `vX.Y.Z` on a
`main` commit that passed CI, publishes `ghcr.io/meldgrove/support-agent`
for amd64 and arm64, moves the branch `stable`, and writes the release notes
from the pull request titles. No file holds the version.

While the version is below 1.0.0, a **patch** release installs without anyone
acting (fixes, features, automatic migrations), and a **minor** release needs
action (label `breaking`). 1.0.0 is a deliberate decision of the
maintainers.

1. Wait for CI to pass on the latest `main` commit.
2. Run the workflow with **Dry run** to see the version, tags and notes.
3. Run it again without **Dry run**.
4. For a release that needs action, put the steps at the top of its notes.

Release builds upload the source maps to the Sentry project
`support-agent` (organization and project in `release.yml`) with the organization
secret `SENTRY_AUTH_TOKEN` (Dockerfile). Without the secret, the release warns
and uploads nothing.

## Data, secrets and privacy

Never commit secrets, real personal data or data from a real organization,
also not in tests and fixtures. Use `example.org` addresses and invented
content.

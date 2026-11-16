# Architecture

An overview for contributors: the parts of the support agent, what happens to
a Slack message, and why it is built this way. The rules for writing code are
in [AGENTS.md](../AGENTS.md).

## Processes

One Docker image runs every process; `APP_ROLE` (the image's command) picks
the role:

| Role      | Runs                                                                            |
| --------- | ------------------------------------------------------------------------------- |
| `web`     | The admin interface: the React app, its API under `/api/v1`, sign-in.           |
| `bot`     | The Slack bot: one Socket Mode connection, the answering pipeline, maintenance. |
| `all`     | Both in one process (simplest setup, one container).                            |
| `migrate` | Applies the database migrations, then exits.                                    |

`compose.yaml` runs `web` and `bot` as separate containers, so the bot keeps
answering while the admin interface is down or being deployed.

PostgreSQL is the only stateful dependency: agents, providers, knowledge
sources, encrypted credentials, the conversation log, sessions and the bot's
status are tables.

```
 admin interface (web)                                   Slack
   React app · /api/v1 · /api/auth (OIDC)                  ▲ │ Socket Mode (outbound
        │ writes + NOTIFY                                  │ ▼  WebSocket, no public URL)
        ▼                                             ┌──────────────┐
   PostgreSQL ──── agents, providers, sources ──────▶ │  bot process │──▶ model providers
        ▲          (LISTEN, and every minute)         │              │──▶ knowledge search APIs
        └──── exchanges, heartbeat ◀──────────────────└──────────────┘
```

## A message, step by step

1. **Slack delivers the event** over the Socket Mode connection. The bot
   acknowledges it at once (Slack redelivers events not acknowledged within
   three seconds) and queues it; `BOT_CONCURRENCY` messages run at a time.
2. **Filter without a model** (`bot/handler.ts`): only channels with an
   enabled agent; no bots, edits or the bot's own messages; nothing older
   than 15 minutes (no late answers after downtime). Top-level messages
   count in reply mode "questions", or with a mention; thread replies count
   with a mention, or as follow-ups in threads the agent answered (if the
   agent allows it and the reply mentions nobody else).
3. **Record the exchange.** One row per Slack message (unique on channel and
   message timestamp), so a redelivered event stops here.
4. **Triage** (`agent/pipeline.ts`): one model call decides whether to answer
   and writes one to three search queries. Most chatter ends here, silently.
5. **Search** every knowledge source with every query, in parallel; merge
   the passages by rank (at most 12) and give each a ref (`S1`, `S2`, …).
6. **Answer:** one model call with the passages, the thread and the
   question. It answers only from the passages and names the refs it used,
   or reports that they don't answer the question.
7. **Post** in the thread: the answer converted to Slack mrkdwn, plus links
   to the cited passages. The model never writes links of its own into that
   line. Without an answer, the agent posts its escalation message or stays
   silent; on errors it posts the error message from the settings and
   alerts the alert channel.
8. **Update the exchange** with outcome, sources, model, tokens and timing.

The test console and saved tests run steps 4 to 7 through the same code
(`runPipeline`), without Slack.

## Models

`llm/` has two adapters behind one interface (`LlmClient.chatJson`): the
Anthropic SDK for Anthropic, and OpenAI's chat completions for OpenAI,
Mistral AI and every OpenAI-compatible API. Both steps ask for a JSON object
with a hand-written schema (strict structured output); an API that rejects
structured output gets JSON mode, then a plain prompt. Replies are validated
with zod; an invalid reply gets one correction round. When the main model
fails or refuses, the agent's fallback model takes over for the rest of the
message.

## Configuration changes

The admin interface writes to the database and sends `NOTIFY
support_agent_config` in the same transaction. The bot listens on that channel
and reloads within a second; it also reloads every minute. When a reload
fails (database unreachable), the bot keeps its last good configuration.
When the Slack tokens change, it reconnects.

## Staying up

- **Watchdog:** when Slack stays unreachable for `BOT_WATCHDOG_SECONDS`, the
  bot exits with an error; the container restart policy starts a fresh
  process. Rejected tokens don't trigger it (a restart would not help); the
  status page shows the problem instead.
- **Heartbeat:** every 30 seconds the bot writes its state to `bot_status`
  (shown on the admin interface's overview) and, while healthy, touches
  `BOT_HEARTBEAT_FILE` for the container health check.
- **Bounded waits:** model calls time out after 60 seconds with one retry,
  searches after 20 seconds, Slack calls after 20 seconds.
- **Visible failures:** errors become a reply ("can't answer right now"), an
  alert in the alert channel (once per agent and error per 15 minutes), an
  error-level log line (and an error report when `SENTRY_DSN` is set), and
  an exchange with outcome `error`.

## Data and privacy

- **Credentials** (API keys, Slack tokens, search secrets) are encrypted with
  AES-256-GCM and `ENCRYPTION_KEY`. The API never returns them; it shows the
  last four characters.
- **Message texts** (question, answer, reason, search queries) are removed
  after the retention period (`retentionDays`, default 90; 0 stores none).
  Outcome, sources, model, timings and tokens stay for a year.
- **Logs and error reports** carry identifiers, never message texts or keys.
- **Model providers** receive the question, the thread and the passages
  found. Choose providers your organization allows for that data.
- **Prompt injection:** retrieved passages and messages are marked as data,
  and the bot has no tools besides search: the worst a malicious message or
  page can do is change one answer.

## Sign-in and roles

Better Auth with one OpenID Connect provider; no passwords. Nobody can sign
up: people sign in once an admin added their email address, and addresses in
`ADMIN_EMAILS` are always active admins (first setup and recovery).
Admins manage everything; editors manage agents, tests and the
conversation log, but not providers, keys, Slack, users or settings.

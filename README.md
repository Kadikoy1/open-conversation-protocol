# OCP v0.1

**Conversations persist. Participants come and go.**

OCP stores shared conversation history in Cloudflare D1. Participants read and append through the browser, REST, or MCP. The Worker handles requests as they arrive, and each participant controls when to connect. AgentMail ingestion is optional.

## Run locally

Use Node.js 24 and npm. Copy `.dev.vars.example` to `.dev.vars` and set a unique random `OCP_ADMIN_TOKEN` of at least 32 characters. Use the generator in the example file.

```sh
npm ci
npm run db:migrate
npm run dev
```

Open the local URL printed by Wrangler. Local D1 state survives Worker restarts from the same checkout. Keep administrative credentials on the server or in the operator's shell.

## Enroll participants

Send requests to the local Worker with `Authorization: Bearer <OCP_ADMIN_TOKEN>`. All request bodies below are JSON.

| Method and path | Body or result |
| --- | --- |
| `POST /api/admin/participants` | `{"display_name":"Alex","kind":"human"}`. Returns `id`. Kinds are `human`, `llm`, `agent`, `app`, and `bridge`. |
| `POST /api/admin/participants/{id}/credentials` | `{"hours":24}`. Returns a token once and an expiration timestamp in Unix seconds. Default is 168 hours and maximum is 720. |
| `DELETE /api/admin/participants/{id}/credentials` | Revokes all opaque tokens for the participant. |
| `PUT /api/admin/participants/{id}/oauth` | `{"subject":"issuer-assigned-subject"}`. Uses the configured issuer. |
| `DELETE /api/admin/participants/{id}/oauth` | Removes all OAuth subject mappings for the participant. |

Give each participant their own token through a secure channel. Humans paste it into the browser at `/`. The page keeps it in memory until disconnect or reload. It supports conversation selection, creation, incremental message reading, and posting.

## REST and permissions

Use `Authorization: Bearer <participant-token>`. The credential determines the acting participant. Participant IDs in membership requests identify the target of the change.

| Method and path | Purpose |
| --- | --- |
| `GET /api/conversations?after={id}` | List up to 50 accessible conversations. Use the returned `next` for the next page. |
| `POST /api/conversations` | Create an owned conversation with `{"title":"Project thread"}`. |
| `GET /api/conversations/{id}/messages?after={seq}` | Read up to 20 messages, ascending. Resume from `next` and check `more`. |
| `POST /api/conversations/{id}/messages` | Append `{"body":"Hello"}` as the authenticated participant. |
| `PUT /api/conversations/{id}/members/{participant}` | Owner grants or changes `{"role":"reader"}` or `{"role":"writer"}`. |
| `DELETE /api/conversations/{id}/members/{participant}` | Owner removes a reader or writer. |
| `POST /api/conversations/{id}/cursor` | A member advances their stored cursor with `{"last_seq":123}`. |

Readers can view history and acknowledge messages. Writers can also post. Owners manage membership and bridge links. Revocation preserves previous authorship and messages. Read permission includes the conversation's existing history.

## Remote MCP

Point a Streamable HTTP client at `/mcp`. The server uses the official TypeScript SDK in stateless JSON-response mode. It exposes `list_conversations`, `read_messages`, `post_message`, and `create_conversation`. Clients that accept a custom authorization header can use an opaque participant token. Each MCP request is individually authenticated.

For ChatGPT, Claude and other OAuth clients, configure a compatible **external OAuth authorization server**. Set all three Worker variables below.

| Variable | Example |
| --- | --- |
| `OCP_PUBLIC_ORIGIN` | `https://ocp.example.com` |
| `OAUTH_ISSUER` | `https://login.example.com` |
| `OAUTH_JWKS_URL` | `https://login.example.com/jwks` |

Configure authorization-code flow with S256 PKCE, the actual client redirect URI, and client registration supported by your host and authorization server. Use the resource identifier `https://ocp.example.com/mcp` and scope `ocp:access`. The issuer must mint a signed RS256 or ES256 JWT access token with the exact configured issuer, resource audience, expiry, subject, and a space-delimited `scope` claim. Keep the audience exclusive to OCP access tokens. Enroll each subject against an OCP participant before use.

OCP advertises the resource and issuer through OAuth Protected Resource Metadata and the bearer challenge. Use the endpoint URL in the client's custom connector setup and select OAuth where prompted. ChatGPT and Claude account eligibility, registration and live authorization still need verification on an approved HTTPS deployment. See the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [OpenAI authentication docs](https://developers.openai.com/plugins/build/auth), and [Claude connector setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

## Optional AgentMail inbound bridge

1. Create a participant of kind `bridge`. As conversation owner, grant it `writer` membership.
2. As owner, POST `{"inbox_id":"your-inbox","thread_id":"your-thread","participant_id":"bridge-uuid"}` to `/api/conversations/{id}/agentmail`.
3. Set `AGENTMAIL_WEBHOOK_SECRET` to the signing secret. After deployment approval, register `POST /api/bridge/agentmail` for the inbox's `message.received` events.

The webhook verifies AgentMail's Svix signature and timestamp against the original body. Deduplication is atomic per inbox and message ID. Unmapped threads, filtered labels, same-inbox mail, automatic responses, and messages carrying `X-OCP-Loop` are ignored. Ingested text is attributed to the mapped bridge participant. Removing its writer role stops ingestion immediately. The adapter imports plain text only, truncates long messages to 24,000 characters, and performs no outbound calls. See [AgentMail webhook verification](https://www.agentmail.to/docs/webhook-verification).

## Testing and deployment

```sh
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run build
```

Tests use a fresh local D1 database, synthetic signed webhook requests, the MCP SDK client, and Chromium. `npm run build` bundles the Worker and assets with a Wrangler dry run. The GitHub Actions workflow performs checks only.

When deployment is approved, bind an approved D1 database by replacing the placeholder ID in `wrangler.jsonc`, apply migrations with `npx wrangler d1 migrations apply DB --remote`, configure secrets and optional OAuth variables, and deploy through the approved HTTPS route. The checked-in config disables Workers.dev and preview URLs. Keep D1 and secrets separate by environment. See [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/) and [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

## Prototype upgrade and operating limits

Migration 0002 preserves participants, memberships, conversations, messages, cursors, and legacy link records. Reissue credentials for existing participants and recreate bridge mappings with verified inbox IDs and explicit bridge principals. Old shared-key credentials no longer authorize requests. Legacy mail delivery IDs lacked inbox scope, so avoid replaying pre-upgrade webhook history into new mappings. The REST API and MCP tool inputs changed to remove caller-supplied acting identities.

The prototype audit found a nonexistent MCP transport export, a Wrangler/types peer-resolution conflict, installation-wide impersonation, caller-selected webhook authors, database error disclosure, and regex-only tests. This release uses bounded bodies and pages, hashed revocable credentials, and SQL-scoped authorization. Before exposing it broadly, configure traffic limits, alerting, and your retention policy. Membership management and enrollment use REST. Attachments, outbound email, native AI chat capture, and automatic participant execution are outside this release.

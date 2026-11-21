# OCP v0.1

**Conversations persist. Participants come and go.**

OCP stores shared conversation history in Cloudflare D1. Participants connect through the browser, REST, or MCP. The Worker handles incoming requests. AgentMail ingestion is optional.

## Run and test locally

Use Node.js 24 and npm. Copy `.dev.vars.example` to `.dev.vars` and set `OCP_ADMIN_TOKEN` to a fresh 256-bit secret encoded as 64 lowercase hexadecimal characters.

```sh
npm ci
npm run db:migrate
npm run dev
```

Open the local URL printed by Wrangler. Local D1 state survives Worker restarts from the same checkout.

```sh
npx playwright install chromium
npm run typecheck
npm test
npm run build
```

Tests use a fresh local D1 database, synthetic webhook deliveries, the MCP SDK, and Chromium. The build validation and GitHub Actions workflow use a Wrangler dry run.

## Enroll participants

Call the admin API with `Authorization: Bearer <OCP_ADMIN_TOKEN>` and use `Content-Type: application/json` for requests with bodies. Keep the administrator secret in the operator's password manager or secret store.

| Method and path | Body or result |
| --- | --- |
| `POST /api/admin/participants` | `{"display_name":"Alex","kind":"human"}`. Returns `id`. Kinds are `human`, `llm`, `agent`, `app`, and `bridge`. |
| `POST /api/admin/participants/{id}/credentials` | `{"hours":24}`. Returns a token once, plus its expiration in Unix seconds. Default 168 hours, maximum 720. |
| `DELETE /api/admin/participants/{id}/credentials` | Revokes the participant's opaque tokens. |
| `PUT /api/admin/participants/{id}/oauth` | `{"subject":"issuer-assigned-subject","client_id":"registered-connector-id"}`. Enrolls one exact issuer, client, and subject tuple. |
| `DELETE /api/admin/participants/{id}/oauth` | Revokes all OAuth enrollments for the participant. |

Deliver each opaque token to its participant through a secure channel. Humans can paste it into the browser at `/`. The browser keeps it in memory until disconnect or reload. Bridge participants receive their identity through the signed and mapped webhook.

## REST and permissions

Send `Authorization: Bearer <participant-token>`. The token identifies the caller. A participant ID in a membership request identifies the membership being changed.

| Method and path | Purpose |
| --- | --- |
| `GET /api/conversations?after={id}` | List up to 50 accessible conversations. Use `next` for the next page. |
| `POST /api/conversations` | Create an owned conversation with `{"title":"Project thread"}`. |
| `GET /api/conversations/{id}/messages?after={seq}` | Read up to 20 messages in sequence order. Resume from `next` and check `more`. |
| `POST /api/conversations/{id}/messages` | Append `{"body":"Hello"}`. |
| `PUT /api/conversations/{id}/members/{participant}` | Owner assigns `{"role":"reader"}` or `{"role":"writer"}`. |
| `DELETE /api/conversations/{id}/members/{participant}` | Owner removes a reader or writer. |
| `POST /api/conversations/{id}/cursor` | A member advances their stored cursor with `{"last_seq":123}`. |

Readers can view existing history. Writers can also post. Owners retain ownership and manage membership and bridge links. Removal preserves messages and authorship. D1 commits the conversation and owner together. Membership changes and message inserts check authorization in their SQL statements. In a concurrent downgrade, writes committed before the downgrade may appear in history, and later writes require writer access.

## Remote MCP and OAuth

Use `https://<hostname>/mcp` with Streamable HTTP. The tools are `list_conversations`, `read_messages`, `post_message`, and `create_conversation`. Clients that support a fixed authorization header can use an operator-issued opaque token. OAuth provides individually enrolled connector access. With OAuth enabled, MCP clients can initialize and list tool schemas before sign-in. Tool execution requires authentication and conversation permissions.

### Configure an external authorization server

1. Register `https://<hostname>/mcp` as the OAuth resource and `ocp:access` as its scope. Publish OAuth discovery metadata with the exact issuer, authorization/token endpoints, supported client authentication methods, and `S256` PKCE. Carry the same RFC 8707 `resource` through authorization and token exchange.
2. Configure authorization-code grants for approved users and clients. If the issuer offers refresh tokens, preserve the original client, subject, scope, and resource on refresh. Restrict the OCP audience and scope to user-authorized grants. Disable client-credentials grants for this resource. Use immutable subjects from the issuer rather than email or display names.
3. Issue RFC 9068 JWT access tokens using RS256 or ES256, with header `typ: at+jwt`, exact `iss`, sole `aud` of `https://<hostname>/mcp`, and `sub`, `client_id`, `iat`, `exp`, `jti`, and space-delimited `scope` containing `ocp:access`. Limit access-token lifetime to at most one hour. Publish the corresponding public signing keys at a stable HTTPS JWKS URL. Rotate keys with overlap for valid outstanding tokens.
4. For ChatGPT, enable OAuth in the connector management UI. Use CIMD if supported by your issuer or register a client using the registration mode shown by ChatGPT. Use the exact client ID and redirect URI displayed for the connection. To use ChatGPT's stable callback, publish RFC 9207 issuer identification support and return matching `iss` in authorization responses. For a client configured without that support, use the callback-ID-specific redirect shown by ChatGPT.
5. For Claude, add a custom remote MCP connector with OAuth. If using your own registered client, enter its client ID and issued secret in Claude and register `https://claude.ai/api/mcp/auth_callback` at the issuer. If using published client identity or automatic registration, enroll Claude's actual client ID after registration.
6. Verify each connector's actual client ID and the user's immutable subject in the trusted issuer's management interface or signed grant. Enroll the pair for the intended OCP participant via `PUT /api/admin/participants/{id}/oauth`. Pairwise subjects can differ between clients. Repeat for each approved pair. A previous subject-only enrollment must be explicitly re-approved with a client ID.

OCP verifies access tokens against HTTPS JWKS and checks the signed client ID against the enrollment. This restricts which client can obtain an accepted grant. As with other bearer credentials, anyone holding a valid token can present it until expiry or revocation. Keep tokens out of logs, and remove the OCP enrollment promptly if access is lost. Live connector validation requires an approved endpoint and issuer. [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [ChatGPT OAuth setup](https://developers.openai.com/plugins/build/auth), [Claude connector setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068.html)

## Optional AgentMail bridge

1. Create a participant of kind `bridge` and grant it `writer` membership in the conversation.
2. As owner, POST `{"inbox_id":"your-inbox","thread_id":"your-thread","participant_id":"bridge-uuid"}` to `/api/conversations/{id}/agentmail`.
3. After approval, set `AGENTMAIL_WEBHOOK_SECRET` and register `POST /api/bridge/agentmail` for AgentMail's `message.received` events.

The webhook authenticates the provider delivery and uses the mapped bridge as the OCP author. The original `From` and `Reply-To` values appear as `email_sender_claims` with `verified: false`. A signed webhook establishes who delivered the event. It does not establish ownership of a claimed email address. Pre-upgrade and non-email messages return `null` for that field. Deduplication is atomic per inbox and message ID. Unmapped threads, reflected mail, automatic replies, and filtered labels are ignored. Removing the bridge's writer role stops ingestion. The adapter imports plain text and makes no outbound calls. [AgentMail webhook verification](https://www.agentmail.to/docs/webhook-verification)

## Private HTTPS deployment

Proceed only with approval for the account, hostname, database, and OAuth issuer. The hosted MCP clients must be able to reach HTTPS discovery and `/mcp` from their infrastructure. OCP data is private through enrollment, credentials, and membership. The network endpoint is reachable by the connector hosts. A VPN-only endpoint or blanket Cloudflare Access login in front of MCP will block hosted clients.

1. Run the checks above. Select an active Cloudflare zone and an unused dedicated subdomain such as `ocp.example.com`. Choose a D1 database dedicated to this environment. Use a least-privilege Cloudflare operator credential for the approved Worker, D1 database, and zone.
2. Copy `wrangler.jsonc` to the ignored `wrangler.private.jsonc`. Set the Worker name and the exact approved D1 `database_name` and `database_id`. Keep `workers_dev` and `preview_urls` false. Use distinct rate-limit namespace IDs for each environment and retain both bindings. Add the following top-level configuration, substituting your actual host and issuer.

   ```jsonc
   "routes": [{ "pattern": "ocp.example.com", "custom_domain": true }],
   "vars": {
     "OCP_PUBLIC_ORIGIN": "https://ocp.example.com",
     "OAUTH_ISSUER": "https://login.example.com",
     "OAUTH_JWKS_URL": "https://login.example.com/jwks"
   }
   ```

3. Before attaching that hostname, enable HTTPS enforcement for it and add a Cloudflare WAF custom rule restricting the admin API to operator egress addresses, or a path-scoped Cloudflare Access policy for `ocp.example.com/api/admin/*`. For the WAF option, set the action to **Block** and use this expression with your real administrator CIDRs. Leave discovery and `/mcp` reachable for the connectors.

   ```
   (http.host eq "ocp.example.com" and starts_with(http.request.uri.path, "/api/admin/") and not ip.src in {192.0.2.10/32})
   ```

   The Worker already applies approximate per-location limits of 240 requests/minute per Cloudflare client IP and route group, followed by 120 requests/minute per authenticated participant across REST and MCP. Admin and bridge traffic have independent IP buckets. Limits return HTTP 429 with `Retry-After`; they are abuse controls, not global quotas. For tighter perimeter limits, configure a Cloudflare WAF rate rule for the custom hostname with the thresholds your client traffic supports. [Workers rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
4. Generate a fresh administrator secret and prepare an ignored `.env.private` file with `OCP_ADMIN_TOKEN=<64 lowercase hex characters>`. Keep the AgentMail secret unset until approved. From the repository root, validate the target configuration locally, then apply the migrations and deploy only to the approved environment.

   ```sh
   npx wrangler deploy --dry-run --config wrangler.private.jsonc
   npx wrangler d1 migrations apply DB --remote --config wrangler.private.jsonc
   npx wrangler deploy --config wrangler.private.jsonc --secrets-file .env.private
   ```

5. Verify HTTPS and the Worker route. Confirm discovery returns the exact resource and issuer and that unauthenticated REST calls return 401. Use an enrolled test user from each approved connector to list and read a designated test conversation. Verify a second user without membership cannot access it. Configure retention and monitoring for the environment before using real data.

For an upgrade, apply all pending migrations in order. Existing workspaces keep their messages and membership. Reissue older administrator material in the required format and re-enroll any subject-only OAuth mappings. Legacy bridge records without a verified inbox and bridge principal require explicit re-linking. [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/), [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

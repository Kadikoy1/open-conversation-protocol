# OCP staging runbook

OCP persists the conversation in D1. ChatGPT and Claude connect as separate participants. A human operator grants membership, then the clients can leave and return independently.

## Release gates and owner decisions

- Approve the exact commit, the creation or use of one **staging-only** Worker and D1 database, and attachment of an HTTPS hostname in an existing Cloudflare zone. Hosted ChatGPT and Claude need a reachable endpoint. OCP data stays behind authentication and membership.
- Supply the approved Cloudflare account, zone, unused staging hostname, and operator egress IP ranges. Use an existing staging D1 database only after verifying its name and UUID. Confirm a free plan is available and within quota, or obtain separate approval for any spend. Use an account-scoped operator login or secret-store token with access to the Worker, D1 and zone. Share access through the provider, never paste credentials into chat or GitHub.
- Approve a dedicated Auth0 staging tenant (or nominate an existing issuer with equivalent token behavior) and the registration of only the approved ChatGPT and Claude OAuth clients. Assign an issuer administrator and two separate test users. Confirm the ChatGPT workspace permits custom MCP tools with writes and the Claude account or organization permits remote connectors.
- Approve the live demo window, synthetic input, and retention period. Decide who can see the Cloudflare and issuer logs. Keep AgentMail disabled for the first run.

### Review of the merged code

The merged implementation in `4a1d709` has all three D1 migrations. Migration 0001 creates the conversation and membership tables. Migration 0002 adds credentials and bridge mappings. Migration 0003 adds client-bound OAuth enrollments and email sender fields. Start staging with an empty database. The Worker validates membership in D1 on each conversation operation. Closing a chat or logging out leaves D1 history intact. The sample config has a placeholder D1 ID and no public route. The staging config uses separate Worker and D1 names and separate rate-limit namespace IDs.

Remaining live gates are an owned HTTPS hostname protected at the edge, a correctly configured issuer, and acceptance of actual tokens issued to both hosted clients. The OAuth tests use fixtures and the MCP tests use the SDK. The combined flow with hosted accounts, provider UI and edge policies still requires approval and verification. OCP uses bearer tokens, supports a single configured issuer per Worker, and has no in-app retention or conversation deletion workflow. Use synthetic data and an isolated database for this demo.

## Configure the staging issuer

**Recommended for the first demo: Auth0 with a dedicated staging tenant.** Its managed login, RFC 9068 access token profile, resource-parameter support and approved client registration fit the existing OCP verifier. OCP itself remains issuer-neutral. Use the tenant's included Auth0 domain and a staging-only user directory. [Auth0 MCP overview](https://auth0.com/blog/auth0-auth-for-mcp-servers-generally-available/), [Access token profiles](https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles)

1. In the tenant dashboard, open **Settings → Advanced** and enable **Resource Parameter Compatibility Profile**. This allows the MCP `resource` field to target the OCP API. For manual CIMD, enable **Client ID Metadata Document Registration** and keep **CIMD with Dynamic Registration** off. Keep ordinary dynamic registration off if both clients can use manually approved CIMD or predefined registrations. Enable Dynamic Client Registration only if an approved host needs it and the owner accepts the broader registration surface. Use only explicit grants to the staging API. [Resource parameter setting](https://support.auth0.com/center/s/article/mcp-audience-error-with-auth0), [Auth0 client grants](https://auth0.com/docs/get-started/applications/application-access-to-apis-client-grants)
2. In **Applications → APIs**, create an API whose identifier is the exact full URL `https://<staging-host>/mcp`, including the path. On the API set RS256, the **RFC 9068** access-token profile, and a token lifetime of 600 seconds. In **Permissions** add `ocp:access`. Require a client grant for user access where the tenant supports the policy and authorize only the two actual connector clients for that permission. Make only the dedicated demo connection available to third-party clients by promoting it to the tenant or domain level. Restrict grants to authorization-code with S256 PKCE. Refresh tokens are optional. If enabled, use rotation and retain the original resource, scope, client and subject. Leave service-to-service grants and third-party OIDC scopes disabled for this demo. Request `ocp:access` as an API scope with the exact resource. If a client requests `openid` and Auth0 adds a userinfo audience, the OCP verifier will reject that token. Resolve at the client or issuer before proceeding. [Auth0 MCP configuration](https://auth0.com/ai/docs/mcp/get-started/call-your-apis-on-users-behalf), [Access token profiles](https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles)
3. Fetch tenant discovery and record its exact issuer (including a trailing slash if present) and HTTPS `jwks_uri`. Confirm it publishes authorization and token endpoints, S256, and an auth method compatible with the selected client registration mode. Keep these values in the staging configuration. Use issuer-advertised discovery even when the issuer has a custom domain. [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

   ```bash
   curl --fail-with-body --silent --show-error \
     https://YOUR_TENANT.YOUR_REGION.auth0.com/.well-known/openid-configuration |
     jq '{issuer,jwks_uri,authorization_endpoint,token_endpoint,
          code_challenge_methods_supported,token_endpoint_auth_methods_supported,
          client_id_metadata_document_supported,registration_endpoint,
          authorization_response_iss_parameter_supported}'
   ```

4. Register each approved client using its actual redirect URI. For CIMD, use **Applications → Applications → Create Application → Import from URL**, enter the URL shown by the host, and review its redirect URIs and authentication methods before granting API access. Use the client identity that the issuer actually puts in the signed `client_id` claim when enrolling the participant. With DCR, record the client ID of the registration the host created and explicitly grant `ocp:access`. Re-creating a connection can change that ID. A preregistered client must use the same authentication method in the host and issuer.
   - **ChatGPT:** use the CIMD URL and redirect shown by the connection UI. The stable redirect is `https://chatgpt.com/connector_platform_oauth_redirect` when supported by the issuer's RFC 9207 configuration. Otherwise register the displayed `https://chatgpt.com/connector/oauth/{callback_id}` URI. Never guess the callback ID or use a wildcard.
   - **Claude:** use its published CIMD identity if supported, or separately register a predefined OAuth client and choose **Use your own OAuth client**. For a predefined client, register `https://claude.ai/api/mcp/auth_callback` and configure its client ID and issued secret in Claude.
   - Use the tenant and host capabilities actually advertised. For a free Auth0 tenant, use a mutually supported method such as CIMD public-client exchange (`none`) with S256 where the approved client supports it. Auth0 lists `private_key_jwt` for CIMD as Enterprise-only. If the host insists on that method, use an approved alternative registration mode or compatible issuer after confirming the owner decision. Pause if S256 is unavailable. [Auth0 CIMD registration](https://auth0.com/docs/get-started/auth0-overview/create-applications/register-applications-with-cimd), [ChatGPT OAuth](https://developers.openai.com/plugins/build/auth), [Claude OAuth](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
5. Create separate issuer users for the two demo clients and disable public self-signup on the demo connection. Obtain their immutable `sub` values from Auth0 and verify the subjects against actual issuer grants. OCP requires a signed RS256 or ES256 `at+jwt` token with the exact `iss`, a sole audience of the MCP URL, and `sub`, `client_id`, `iat`, `exp`, `jti` and `scope` containing `ocp:access`. Inspect claims locally using approved test tooling, without saving the token or submitting it to an external decoder. Stop if either real client cannot produce and use a token matching this contract.

## Cloudflare deployment checklist

### Prepare and validate locally

Use Node.js 24, npm, Bash, curl and jq for the commands below. Execute from the repository root. The configuration template has no route and uses a dummy D1 UUID. Both Cloudflare default URLs are disabled.

```bash
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run build
npx wrangler deploy --dry-run --config wrangler.staging.example.jsonc --outdir dist/staging
npx wrangler d1 migrations apply DB --local --config wrangler.staging.example.jsonc --persist-to .wrangler/staging-preflight
npx wrangler d1 migrations list DB --local --config wrangler.staging.example.jsonc --persist-to .wrangler/staging-preflight
```

Expect migrations 0001, 0002 and 0003 to apply. The subsequent list should report no unapplied migrations. The preflight state is disposable local test data.

### Configure and deploy only after approval

1. Sign in using the approved operator account and verify the account using `npx wrangler whoami`. If a new database was approved and one does not already exist for staging, run `npx wrangler d1 create ocp-v01-staging` and record its UUID. Use `npx wrangler d1 list` to double-check the account, database name and UUID. Never select a production database.
2. Run `cp wrangler.staging.example.jsonc wrangler.staging.jsonc`. In the ignored copy, set the D1 UUID and database name, and replace all example origins and Auth0 values with the exact ones below. Confirm the rate-limit namespace IDs are unused in the account before adopting `1101` and `1102`. Keep the staging Worker name, account or isolation boundary, database, issuer tenant, rate-limit namespaces and secrets distinct from future production. Set `account_id` in the ignored config if the login can access multiple Cloudflare accounts.
3. Before attaching the hostname, configure HTTPS enforcement on it and restrict `/api/admin/*` with a WAF IP allowlist or path-scoped Cloudflare Access. Keep `/mcp` and the OAuth discovery paths reachable by both providers. Example WAF **Block** rule, replacing the test address and hostname with approved values:

   ```
   (http.host eq "ocp-staging.example.com" and starts_with(http.request.uri.path, "/api/admin/") and not ip.src in {192.0.2.10/32})
   ```

   The Worker independently requires an admin secret and applies pre-auth IP limits and participant limits. A broad bot challenge or interactive Access prompt can break hosted MCP clients. Leave the webhook secret unset and optionally block the AgentMail path at the edge. [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [Workers rate limits](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
4. Add a top-level route entry to the ignored config for the approved hostname. Cloudflare creates the DNS record and certificate for a Custom Domain in an active zone. Match the exact hostname in the variable, the OAuth resource ID and the route.

   ```jsonc
   "routes": [{ "pattern": "ocp-staging.example.com", "custom_domain": true }],
   ```

   | Setting | Value |
   | --- | --- |
   | `OCP_PUBLIC_ORIGIN` | `https://<staging-host>` with no trailing slash |
   | `OAUTH_ISSUER` | Exact tenant discovery issuer, including its slash if present |
   | `OAUTH_JWKS_URL` | Exact tenant discovery `jwks_uri` |
   | `OCP_ADMIN_TOKEN` | Secret generated independently for staging, 64 lowercase hex characters |
   | `AGENTMAIL_WEBHOOK_SECRET` | Leave unset for this experiment |

   Save the admin secret in the operator's vault and place it in a vault-managed or temporary ignored `.env.staging` file. A secure local generator is `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Set permissions so only the operator can read the file. OAuth client secrets, when applicable, belong in the issuer and respective host setup, outside the Worker config.
5. Validate the approved target, review pending migrations, then apply them before publishing the Worker. Remove `.env.staging` from the workstation when the deployment ends according to your secret-handling process.

   ```bash
   npx wrangler deploy --dry-run --config wrangler.staging.jsonc --outdir dist/staging
   npx wrangler d1 migrations list DB --remote --config wrangler.staging.jsonc
   npx wrangler d1 migrations apply DB --remote --config wrangler.staging.jsonc
   npx wrangler d1 migrations list DB --remote --config wrangler.staging.jsonc
   npx wrangler deploy --config wrangler.staging.jsonc --secrets-file .env.staging
   ```

6. Verify certificate and hostname, app discovery, and gate behavior. Check the admin path from both an approved and an unapproved network. No credentials should be sent by HTTP. Verify the Worker and D1 identifiers in the Cloudflare dashboard, and ensure there is no route on a production hostname.

   ```bash
   OCP='https://ocp-staging.example.com'
   curl --fail-with-body --silent --show-error "$OCP/.well-known/oauth-protected-resource/mcp" | jq .
   curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' "$OCP/api/conversations"
   curl --silent --show-error --dump-header - --output /dev/null "$OCP/mcp"
   ```

   The discovery resource must be `$OCP/mcp` and the server list must name the exact issuer. Anonymous REST and an unauthenticated MCP GET should return 401. The MCP challenge must advertise discovery and `ocp:access`. Anonymous MCP POST initialization and discovery can return public tool schemas. An anonymous tool call must request authentication and return no conversation data.

## Connect the two hosts

### ChatGPT

1. In **ChatGPT → Plugins**, select **+ → Add custom MCP server**. Name it **OCP Staging** and enter the approved `https://<staging-host>/mcp` URL. Choose OAuth with the approved registration mode and use the exact client metadata and callback values from the management UI during issuer setup.
2. Review the permissions, create the plugin for private use, and verify the four tools are visible. Keep it in the demo workspace or personal installation. Start a new chat and select the plugin with `@`. Invoke `list_conversations` to trigger sign-in if needed. Sign in as the ChatGPT test user. [OpenAI setup](https://developers.openai.com/plugins/deploy/connect-chatgpt)
3. Enroll the verified issuer, client and subject against the ChatGPT participant as described below. A successful list with no rooms is expected for a new participant.

### Claude

1. In **Customize → Connectors**, select **+ Add → Add custom connector**. For Team or Enterprise, the organization owner first uses **Organization settings → Connectors → Add → Custom → Web**, then the tester connects from **Customize → Connectors**.
2. Enter the same HTTPS MCP URL and review the detected OAuth settings. Choose **Sign in now** or **Sign in when needed**, select the approved OAuth client mode, and add the connector. Use the Claude test user. Enable the connector in a new chat using **+ → Connectors**. [Claude setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
3. Enroll its client and subject against the distinct Claude participant. The Claude participant will see the room once its owner grants membership.

### Enroll demo participants

Use a trusted operator shell on the approved network. Complete any registration needed to learn client IDs before enrollment. If the first tool call returns an enrollment error, record the matching issuer grant, enroll it, then retry authorization or refresh the connection. The operator uses the admin secret to create four distinct participants and map the two verified grants. Names are display labels and confer no permissions.

```bash
set -euo pipefail
read -rs -p 'Staging admin token: ' ADMIN
printf '\n'
ocp_call() {
  local token="$1"; shift
  printf 'Authorization: Bearer %s\n' "$token" |
    curl --fail-with-body --silent --show-error --header @- \
      --header 'Content-Type: application/json' "$@"
}
participant() {
  ocp_call "$ADMIN" -X POST "$OCP/api/admin/participants" \
    --data "$(jq -nc --arg name "$1" --arg kind "$2" '{display_name:$name,kind:$kind}')" | jq -er .id
}
enroll() {
  ocp_call "$ADMIN" -X PUT "$OCP/api/admin/participants/$1/oauth" \
    --data "$(jq -nc --arg subject "$2" --arg client_id "$3" '{subject:$subject,client_id:$client_id}')"
}
CHATGPT_ID=$(participant 'ChatGPT Demo' llm)
CLAUDE_ID=$(participant 'Claude Demo' llm)
HUMAN_ID=$(participant 'Demo Observer' human)
OUTSIDER_ID=$(participant 'Demo Outsider' human)
# Set the four variables below to the verified issuer values before running these lines.
enroll "$CHATGPT_ID" "$CHATGPT_SUB" "$CHATGPT_CLIENT_ID"
enroll "$CLAUDE_ID" "$CLAUDE_SUB" "$CLAUDE_CLIENT_ID"
```

## First interoperability experiment

Record the approved commit and hostname, when each tool ran, the returned conversation and participant IDs, sequence numbers, and expected versus actual results. Keep evidence to synthetic content and response status. Never record bearer tokens, OAuth authorization codes or client secrets.

1. **ChatGPT creates and writes.** Call `create_conversation` with title `OCP staging exchange`. Record the returned conversation ID. Call `post_message` with that ID and the exact text `OCP demo A: ChatGPT was here.` Check the first message has the ChatGPT participant ID.
2. **Grant Claude and the observer access.** MCP has no membership tool. Temporarily issue an opaque token to the fresh ChatGPT demo participant and use it only in the operator shell to call the owner REST endpoint. Grant Claude `writer` and the human `reader`. Revoke the temporary token immediately. ChatGPT's OAuth enrollment remains active. Do this before Claude's read.

   ```bash
   # Set ROOM_ID to the UUID returned by create_conversation.
   issue_demo_token() {
     ocp_call "$ADMIN" -X POST "$OCP/api/admin/participants/$1/credentials" \
       --data '{"hours":1}' | jq -er .token
   }
   OWNER_TOKEN=$(issue_demo_token "$CHATGPT_ID")
   ROOM="$OCP/api/conversations/$ROOM_ID"
   ocp_call "$OWNER_TOKEN" -X PUT "$ROOM/members/$CLAUDE_ID" --data '{"role":"writer"}'
   ocp_call "$OWNER_TOKEN" -X PUT "$ROOM/members/$HUMAN_ID" --data '{"role":"reader"}'
   ocp_call "$ADMIN" -X DELETE "$OCP/api/admin/participants/$CHATGPT_ID/credentials"
   unset OWNER_TOKEN
   ```

   If the operation is interrupted, run the credential revocation command before retrying.
3. **Claude reads and replies.** In a separate Claude chat, use `list_conversations` to locate the room. Call `read_messages` with `after: 0` and verify Claude sees message A. Call `post_message` with `OCP demo B: Claude read A and replied.` Verify the returned message ID differs from A and its sequence is greater.
4. **Close both chats and reopen ChatGPT.** Preserve the two issuer enrollments and D1. Start a fresh ChatGPT conversation with the connector and ask it to locate the room with `list_conversations` and call `read_messages` from `after: 0`. Do not paste A or B into the new chat. Pass if both messages appear once and in order, with the original distinct participant IDs. Use the returned `next` if more pages are available.
5. **Observe through the browser.** Issue a one-hour token with `issue_demo_token "$HUMAN_ID"`, enter it at `$OCP/`, and connect. The same room must display both messages in order and give the observer read-only access.
6. **Verify denials.** Issue a token for the outsider and leave it outside the room. Its list must omit the room. A direct request for `GET /api/conversations/{id}/messages` with its token must return 404 and no history. A direct POST with a synthetic body must return 403. The observer's POST must also return 403. For stronger hosted OAuth verification, remove Claude's membership after the successful demo and repeat the read as Claude using the still-enrolled connector. Its list must omit the room and an explicit read by ID must return a tool error. Use a fresh temporary owner token for the membership removal and revoke it immediately.
7. **Wrap up.** Revoke human and outsider opaque credentials and remove both OAuth enrollments via the administrator API. If the environment remains approved for future demos, retain the synthetic D1 history until the agreed retention deadline. If staging must close, disable its route and revoke issuer grants or test users under the owner's cleanup approval. Do not delete the database until retention and disposal are authorized.

## Expected infrastructure and costs

A single Worker and D1 database on Cloudflare's free plan, an existing Cloudflare zone, and a managed issuer tenant are sufficient for a small synthetic demonstration if each account has free quota and the chosen features. Cloudflare lists 100,000 free Worker requests per day and D1 allowances of 5 million rows read and 100,000 rows written per day. Free D1 databases have a 500 MB per-database limit. Auth0 lists a free plan with Auth for MCP included. Confirm the exact tenant features and quotas in the owner accounts. A pre-existing domain or client subscription can carry separate costs. No paid upgrade, separate compute, model API key, mailbox, or background runner is needed for this plan. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Auth0 pricing](https://auth0.com/pricing)

Monitor Worker failures, 401/403/429 rates, D1 daily usage, and issuer failures during the demo. Shared provider IPs can hit an approximate per-location IP rate limit before individual participant limits. Respect `Retry-After`; inspect request logs and usage before tuning. For an incident, revoke affected credentials or enrollments and disable the staging route if needed. Worker rollback does not roll back D1 migrations or history. Preserve the staging database for review and use the agreed retention policy.

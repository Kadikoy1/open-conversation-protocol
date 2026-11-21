# OCP staging runbook

OCP persists the conversation in D1. ChatGPT and Claude connect as separate participants. A human operator grants membership, then the clients can leave and return independently.

## Release gates and owner decisions

- Approve the exact commit, the creation or use of one **staging-only** Worker and D1 database, and attachment of an HTTPS hostname in an existing Cloudflare zone. Hosted ChatGPT and Claude need a reachable endpoint. OCP data stays behind authentication and membership.
- Supply the approved Cloudflare account, zone, unused staging hostname, and operator egress IP ranges. Use an existing staging D1 database only after verifying its name and UUID. Confirm a free plan is available and within quota, or obtain separate approval for any spend. Use an account-scoped operator login or secret-store token with access to the Worker, D1 and zone. Share access through the provider, never paste credentials into chat or GitHub.
- Approve a dedicated Auth0 staging tenant (or nominate an existing issuer with equivalent token behavior) and the registration of only the approved ChatGPT and Claude OAuth clients. Assign an issuer administrator and two separate test users. Confirm the ChatGPT workspace permits custom MCP tools with writes and the Claude account or organization permits remote connectors.
- Approve the live demo window, synthetic input, and retention period. Decide who can see the Cloudflare and issuer logs. Keep AgentMail disabled for the first run.

### Review of the merged code

The merged implementation in `4a1d709` has all three D1 migrations. Migration 0001 creates the conversation and membership tables. Migration 0002 adds credentials and bridge mappings. Migration 0003 adds client-bound OAuth enrollments and email sender fields. Start staging with an empty database. The Worker validates membership in D1 on each conversation operation. Closing a chat or logging out leaves D1 history intact. The rehearsal template uses a placeholder D1 ID and has no route. The deployment config targets the existing staging database and a dedicated hostname. It uses separate Worker and D1 names and staging rate-limit namespace IDs.

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

### OCP staging Auth0 preflight

The staging config pins the exact Auth0 issuer (including its trailing slash) and its HTTPS JWKS URL. The OCP API identifier is `https://staging.openconversationprotocol.org/mcp`. Use an access token issued for this API. Auth0's RFC 9068 profile has `typ: at+jwt` and the signed `client_id` and `jti` OCP requires. Auth0's default token profile uses `typ: JWT` and `azp`, which OCP rejects. No Auth0 Action is needed. With RBAC enabled, assign `ocp:access` to the test user as well as granting the client delegated access. Request that scope at authorization. OCP checks the signed `scope` claim, and the optional `permissions` array cannot replace it. [Auth0 access-token profiles](https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles)

Before adding either hosted client, use the existing Native client with its registered callback and S256 PKCE. Request `ocp:access` for the API audience. Also verify that the tenant's Resource Parameter Compatibility Profile accepts the MCP `resource` parameter, since explicitly passing Auth0's `audience` can hide that configuration gap. Confirm the resulting signed token has the sole MCP audience, a short lifetime, the test user's subject and the actual client ID. Enroll the exact pair and call `list_conversations` with an MCP test client that uses the Native client's bearer token. An empty list is a valid success. Keep the bearer token local to the test operator.

When checking issuer discovery, absence of `client_id_metadata_document_supported: true` means clients cannot autodetect CIMD. Absence of `registration_endpoint` means they cannot discover DCR. A predefined OAuth client can still work if the host accepts supplied credentials. Use separate client registrations for ChatGPT and Claude. For ChatGPT, prefer a predefined client if the selected connection surface accepts one. Otherwise enable manual CIMD discovery and preview the exact ChatGPT metadata document in Auth0 before approving the import. The stable ChatGPT document advertises `none` and `private_key_jwt`, with `private_key_jwt` as its legacy preference. Auth0 supports one method per app and documents `private_key_jwt` for CIMD as Enterprise-only. If the preview maps to that method and the tenant cannot use it, use an approved predefined client or DCR. DCR opens tenant registration and needs an API grant and a domain-level connection. Do not grant the OCP scope to all third-party apps merely to complete connector setup. For Claude, a predefined client with authorization code, S256 and a matching token endpoint authentication method avoids a dependency on the tenant's CIMD or DCR settings. [ChatGPT authentication](https://developers.openai.com/plugins/build/auth), [Auth0 CIMD registration](https://auth0.com/docs/get-started/auth0-overview/create-applications/register-applications-with-cimd), [Claude custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

## Cloudflare deployment checklist

### Prepare and validate locally

Use Node.js 24, npm, Bash, curl and jq for the commands below. Execute from the repository root. The rehearsal template has no route and uses a dummy D1 UUID. The checked-in deployment config, `wrangler.staging.jsonc`, targets only Worker `ocp-staging`, Custom Domain `staging.openconversationprotocol.org` and D1 binding `DB` for `ocp-staging-db` (`ee8696bf-7a1f-408e-8db6-73449a87bdff`). Both default URLs are disabled.

```bash
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run build
npx wrangler deploy --dry-run --config wrangler.staging.jsonc --outdir dist/staging
npx wrangler d1 migrations apply DB --local --config wrangler.staging.example.jsonc --persist-to .wrangler/staging-preflight
npx wrangler d1 migrations list DB --local --config wrangler.staging.example.jsonc --persist-to .wrangler/staging-preflight
```

Expect migrations 0001, 0002 and 0003 to apply. The subsequent list should report no unapplied migrations. The preflight state is disposable local test data.

### Configure and deploy only after approval

1. Sign in using the approved Cloudflare account with `npx wrangler login`, or configure a scoped `CLOUDFLARE_API_TOKEN` through a secret store. Use the account that owns both the database and the zone. If the credential can access multiple accounts, set `CLOUDFLARE_ACCOUNT_ID` to the verified staging account ID before using Wrangler. The first deployment needs Workers Admin for a new Worker (or Editor for an existing Worker) and Workers Routes Write on the zone. For an API token, grant Workers Scripts Write and D1 Write on the staging account, plus Workers Routes Write and Zone Read on `openconversationprotocol.org`. Use a separate dashboard operator for edge-policy edits if needed. [Workers authorization](https://developers.cloudflare.com/workers/authorization/workers/), [D1 API permissions](https://developers.cloudflare.com/d1/observability/debug-d1/)
2. Run these read-only checks before approving any remote write. Confirm the database UUID and the owning account in the output and confirm staging rate-limit namespace IDs `1101` and `1102` are reserved for staging. Verify that `openconversationprotocol.org` is an active zone in the same account and that the staging hostname is available. If an existing DNS record or Custom Domain conflicts, stop and review ownership before making changes.

   ```bash
   npx wrangler whoami
   npx wrangler d1 info ocp-staging-db --config wrangler.staging.jsonc
   ```

3. Before attaching the hostname, configure HTTPS enforcement on it and restrict `/api/admin/*` with a WAF IP allowlist or path-scoped Cloudflare Access. Keep `/mcp` and the OAuth discovery paths reachable by both providers. Example WAF **Block** rule, replacing the test address and hostname with approved values:

   ```
   (http.host eq "staging.openconversationprotocol.org" and starts_with(http.request.uri.path, "/api/admin/") and not ip.src in {192.0.2.10/32})
   ```

   The Worker independently requires an admin secret and applies pre-auth IP limits and participant limits. A broad bot challenge or interactive Access prompt can break hosted MCP clients. Leave the webhook secret unset and optionally block the AgentMail path at the edge. [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [Workers rate limits](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
4. The committed configuration declares the Custom Domain. After approval, `wrangler deploy` attaches it and Cloudflare manages the associated DNS record and certificate. This is the step that activates the hostname.

   | Setting | Value |
   | --- | --- |
   | `OCP_PUBLIC_ORIGIN` | `https://staging.openconversationprotocol.org` (already set) |
   | `OAUTH_ISSUER` | Exact Auth0 tenant issuer with trailing slash (already set) |
   | `OAUTH_JWKS_URL` | Exact Auth0 tenant discovery `jwks_uri` (already set) |
   | `OCP_ADMIN_TOKEN` | Secret generated independently for staging, 64 lowercase hex characters |
   | `AGENTMAIL_WEBHOOK_SECRET` | Leave unset for this experiment |

   Save the admin secret in the operator's vault and place it in a vault-managed or temporary ignored `.env.staging` file. A secure local generator is `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Set permissions so only the operator can read the file. OAuth client secrets, when applicable, belong in the issuer and host setup. The checked-in staging config supplies the issuer and JWKS settings. They take effect when an approved deployment applies the configuration.
5. After remote-write approval, validate the approved target, review pending migrations, then apply them before publishing the Worker. On a fresh database, Wrangler’s remote migration list can initialize its migration tracking table. Treat the first remote list as a database write. Remove `.env.staging` from the workstation when the deployment ends according to your secret-handling process.

   ```bash
   npx wrangler deploy --dry-run --config wrangler.staging.jsonc --outdir dist/staging
   npx wrangler d1 migrations list DB --remote --config wrangler.staging.jsonc
   npx wrangler d1 migrations apply DB --remote --config wrangler.staging.jsonc
   npx wrangler d1 migrations list DB --remote --config wrangler.staging.jsonc
   npx wrangler deploy --config wrangler.staging.jsonc --secrets-file .env.staging
   ```

6. Verify certificate and hostname, app discovery, and gate behavior. Check the admin path from both an approved and an unapproved network. No credentials should be sent by HTTP. Verify the Worker and D1 identifiers in the Cloudflare dashboard, and ensure there is no route on a production hostname.

   ```bash
   OCP='https://staging.openconversationprotocol.org'
   curl --fail-with-body --silent --show-error "$OCP/.well-known/oauth-protected-resource/mcp" | jq .
   curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' "$OCP/api/conversations"
   curl --silent --show-error --dump-header - --output /dev/null "$OCP/mcp"
   ```

   With OAuth configured, the discovery resource must be `$OCP/mcp` and the server list must name the exact issuer. Before then, OAuth discovery returns 404. Anonymous REST and an unauthenticated MCP GET should return 401. The MCP challenge must advertise discovery and `ocp:access`. Anonymous MCP POST initialization and discovery can return public tool schemas. An anonymous tool call must request authentication and return no conversation data.

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

## First read-only authenticated MCP smoke test

Run these steps manually after the reviewed Worker is approved and deployed. The utility requires the new atomic admin route, `POST /api/admin/participants/oauth`. The existing two-step admin API remains available for other workflows. The new route uses the existing OAuth enrollment table and requires no migration.

The route accepts `display_name`, `kind`, `issuer`, `client_id` and `subject`. It checks the issuer against the Worker configuration. A retry for the same issuer, client and subject returns the original participant ID if its name and kind match. A conflicting assignment returns 409. It never transfers an identity to a different participant.

### Enrol from Windows PowerShell 5.1

Run from the repository root with Node.js 24 and `npm ci`. The enrollment command reads the existing ignored `.env.staging` file for `OCP_ADMIN_TOKEN`. Use the already authorized Access service credentials for the admin application, which need a matching Service Auth policy. The following example prompts for the Client Secret without echoing it and clears both variables after the request.

```powershell
$clientId = Read-Host 'Verified Auth0 public Client ID'
$subject = Read-Host 'Verified Auth0 subject'
$env:CF_ACCESS_CLIENT_ID = Read-Host 'Cloudflare Access service Client ID'
$accessSecret = Read-Host 'Cloudflare Access service Client Secret' -AsSecureString
try {
    $env:CF_ACCESS_CLIENT_SECRET = [PSCredential]::new('access', $accessSecret).GetNetworkCredential().Password
    node ./scripts/ocp-enrol-staging.mjs $clientId $subject
} finally {
    Remove-Item Env:CF_ACCESS_CLIENT_SECRET, Env:CF_ACCESS_CLIENT_ID -ErrorAction SilentlyContinue
    Remove-Variable accessSecret
}
```

If your existing Access policy uses an interactive session, use the application-scoped `CF_Authorization` JWT for the staging admin path instead. Load it securely into `OCP_CF_ACCESS_JWT`, leave both service credential variables unset, run the same Node command, and clear the JWT variable afterward. A browser session with additional device or cookie-binding requirements may need the service-credential method. The utility sends credentials only to the pinned staging admin URL and refuses redirects. [Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/), [Access application cookies](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/)

Expect `{"participantId":"<uuid>","status":"created"}` on first use. Run again with the same identity to confirm `already_enrolled` and the same ID. A redirect or 401/403 means the Access session, policy or administrator bearer needs checking. For 409, inspect the existing assignment with the operator and keep it intact until the conflict is understood.

### Obtain a fresh token and list conversations

Use the existing Auth0 Native app and the same test user. Its allowed callback must include `http://127.0.0.1:8765/callback`, the grant must use Authorization Code, and token endpoint authentication must be `None`. Resource mode is the verified staging path.

```powershell
node ./scripts/ocp-auth0-pkce.mjs $clientId resource --list-conversations
```

Open the displayed Auth0 URL in a local browser. The runner validates the fresh token locally first. It then checks that anonymous GET receives an OCP bearer challenge and that anonymous MCP tool execution is denied. Finally, it sends the token directly to staging over HTTPS and uses the MCP SDK to initialize and call `list_conversations`. The report includes verified claims, `mcp.unauthenticated: rejected`, and `mcp.conversationCount: 0` for a new participant. The output excludes conversation contents, credentials and authorization codes. Omitting `--list-conversations` retains local token validation only.

If the unauthenticated MCP probe redirects to Cloudflare Access, review the path scope of the Access application. The admin API should be protected while `/mcp` should return OCP’s OAuth challenge. An authenticated rejection can also indicate an issuer, client or subject that differs from the enrolled tuple. The runner never sends Cloudflare Access credentials to MCP or invokes a write tool.

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

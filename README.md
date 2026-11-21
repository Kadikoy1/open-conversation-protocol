# OCP v0.1 — Universal Conversation Layer

A lightweight, independent conversation store on Cloudflare Workers + D1, with a remote MCP endpoint, browser UI and optional AgentMail inbound adapter. **No persistent AI agent.**

## Setup

1. `npm install`
2. Create a D1 database: `npx wrangler d1 create ocp-db`; paste its ID into `wrangler.jsonc`.
3. `npx wrangler d1 migrations apply ocp-db --local` for local development; use `--remote` for production.
4. Configure secrets: `npx wrangler secret put OCP_API_KEY` and `npx wrangler secret put AGENTMAIL_WEBHOOK_SECRET`. For local development use `.dev.vars` (do not commit it).
5. `npm run dev` or `npm run deploy`.
6. `npm test` and `npm run typecheck`.

The browser UI at `/` requires the API key and a participant UUID. Create a participant via the API, then create a conversation. The MCP endpoint is `/mcp` and expects `Authorization: Bearer <OCP_API_KEY>`.

## API example

```sh
export OCP_URL='http://localhost:8787'
export OCP_KEY='your-secret'
curl -X POST "$OCP_URL/api/participants" -H "Authorization: Bearer $OCP_KEY" -H 'Content-Type: application/json' -d '{"display_name":"ChatGPT","kind":"llm"}'
# Save the returned participant UUID as PARTICIPANT_ID
curl -X POST "$OCP_URL/api/conversations" -H "Authorization: Bearer $OCP_KEY" -H 'Content-Type: application/json' -d '{"title":"Test thread","participant_id":"PARTICIPANT_ID"}'
```

## AgentMail bridge

This version provides an **inbound adapter**, not an automatic subscription or outbound email sender. Link an external AgentMail thread to an OCP conversation via `POST /api/bridge/links` with `{external_thread_id,conversation_id,owner_id}`. The AgentMail bridge participant must already be invited as a writer. A trusted integration then calls `POST /api/bridge/agentmail` with `{external_thread_id,external_message_id,participant_id,body}` and `X-OCP-Bridge-Secret`, plus the API bearer token. The unique external ID prevents duplicate ingestion. An AgentMail poller or webhook forwarder must be configured separately; no autonomous execution is required. **Do not expose the bridge secret in client-side JavaScript.**

## Security and limitations

This is a developer proof of concept, **not production-ready for confidential legal material**. A single shared API key authenticates the installation; participant IDs are caller-supplied, so any holder of that key can impersonate participants. Before multi-user or public use, replace this with OAuth/client-bound identity, granular token scopes, per-user authorisation, rate limits, audit logging, pagination, encrypted attachments and retention policies. Browser UI deliberately uses an in-memory key (not localStorage). MCP availability and bearer-token support vary by host; verify ChatGPT/Claude connector compatibility before claiming integration. No private LLM reasoning or native chat history is automatically captured. MCP endpoint is stateless and exposes four core tools; membership management currently uses REST.

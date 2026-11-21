import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

type Env = { DB: D1Database; OCP_API_KEY: string; AGENTMAIL_WEBHOOK_SECRET?: string };
const app = new Hono<{Bindings:Env}>();
const fail = (message:string) => { throw new Error(message); };
const uid = () => crypto.randomUUID();
function authenticate(header:string|null, key:string) {
  return !!key && header === `Bearer ${key}`;
}
async function requireMember(db:D1Database, cid:string, pid:string, write=false) {
  const row = await db.prepare('SELECT role FROM memberships WHERE conversation_id=? AND participant_id=?').bind(cid,pid).first<{role:string}>();
  if (!row || (write && row.role==='reader')) fail('Participant is not authorised for this conversation');
}
async function list(db:D1Database, pid:string) {
  return (await db.prepare('SELECT c.* FROM conversations c JOIN memberships m ON m.conversation_id=c.id WHERE m.participant_id=? ORDER BY c.created_at DESC').bind(pid).all()).results;
}
async function history(db:D1Database,cid:string,pid:string,after=0) {
  await requireMember(db,cid,pid);
  return (await db.prepare('SELECT seq,id,conversation_id,participant_id,body,source,created_at FROM messages WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT 100').bind(cid,after).all()).results;
}
async function post(db:D1Database,cid:string,pid:string,body:string,source='ocp',externalId:string|null=null) {
  await requireMember(db,cid,pid,true);
  if (!body.trim() || body.length>100000) fail('Message must contain 1–100000 characters');
  const id=uid();
  await db.prepare('INSERT OR IGNORE INTO messages(id,conversation_id,participant_id,body,source,external_id) VALUES(?,?,?,?,?,?)').bind(id,cid,pid,body,source,externalId).run();
  return {id,conversation_id:cid};
}
async function create(db:D1Database,title:string,pid:string) {
  if(!title.trim() || title.length>200) fail('Title must contain 1–200 characters');
  const id=uid();
  await db.batch([db.prepare('INSERT INTO conversations(id,title) VALUES(?,?)').bind(id,title),db.prepare('INSERT INTO memberships(conversation_id,participant_id,role) VALUES(?,?,?)').bind(id,pid,'owner')]);
  return {id,title};
}
app.onError((err,c)=>c.json({error:err.message},400));
app.use('/api/*',async(c,next)=>{if(!authenticate(c.req.header('Authorization')||null,c.env.OCP_API_KEY))return c.json({error:'Unauthorized'},401);await next();});
app.get('/api/conversations',async c=>c.json(await list(c.env.DB,c.req.query('participant_id')||'')));
app.post('/api/participants',async c=>{const b=await c.req.json();const id=uid();await c.env.DB.prepare('INSERT INTO participants(id,display_name,kind) VALUES(?,?,?)').bind(id,b.display_name,b.kind).run();return c.json({id},201);});
app.post('/api/conversations',async c=>{const b=await c.req.json();return c.json(await create(c.env.DB,b.title,b.participant_id),201);});
app.post('/api/conversations/:id/members',async c=>{const b=await c.req.json();await requireMember(c.env.DB,c.req.param('id'),b.inviter_id);const owner=await c.env.DB.prepare('SELECT role FROM memberships WHERE conversation_id=? AND participant_id=?').bind(c.req.param('id'),b.inviter_id).first<{role:string}>();if(owner?.role!=='owner')fail('Only owners can invite');if(!['reader','writer'].includes(b.role))fail('Invalid role');await c.env.DB.prepare('INSERT INTO memberships(conversation_id,participant_id,role) VALUES(?,?,?)').bind(c.req.param('id'),b.participant_id,b.role).run();return c.json({ok:true});});
app.get('/api/conversations/:id/messages',async c=>c.json(await history(c.env.DB,c.req.param('id'),c.req.query('participant_id')||'',Number(c.req.query('after')||0))));
app.post('/api/conversations/:id/messages',async c=>{const b=await c.req.json();return c.json(await post(c.env.DB,c.req.param('id'),b.participant_id,b.body),201);});
app.post('/api/conversations/:id/cursor',async c=>{const b=await c.req.json();await requireMember(c.env.DB,c.req.param('id'),b.participant_id);await c.env.DB.prepare('INSERT INTO cursors(conversation_id,participant_id,last_seq) VALUES(?,?,?) ON CONFLICT(conversation_id,participant_id) DO UPDATE SET last_seq=MAX(last_seq,excluded.last_seq)').bind(c.req.param('id'),b.participant_id,b.last_seq).run();return c.json({ok:true});});
app.post('/api/bridge/agentmail',async c=>{if(!c.env.AGENTMAIL_WEBHOOK_SECRET || c.req.header('X-OCP-Bridge-Secret')!==c.env.AGENTMAIL_WEBHOOK_SECRET)return c.json({error:'Forbidden'},403);const b=await c.req.json();if(!b.external_thread_id||!b.external_message_id||!b.participant_id||!b.body)return c.json({error:'Missing fields'},400);const link=await c.env.DB.prepare('SELECT conversation_id FROM bridge_links WHERE external_thread_id=?').bind(b.external_thread_id).first<{conversation_id:string}>();if(!link)return c.json({error:'Thread not mapped'},404);return c.json(await post(c.env.DB,link.conversation_id,b.participant_id,b.body,'agentmail',b.external_message_id));});
app.post('/api/bridge/links',async c=>{const b=await c.req.json();await requireMember(c.env.DB,b.conversation_id,b.owner_id);const owner=await c.env.DB.prepare('SELECT role FROM memberships WHERE conversation_id=? AND participant_id=?').bind(b.conversation_id,b.owner_id).first<{role:string}>();if(owner?.role!=='owner')fail('Only owners can link');await c.env.DB.prepare('INSERT INTO bridge_links(external_thread_id,conversation_id) VALUES(?,?)').bind(b.external_thread_id,b.conversation_id).run();return c.json({ok:true});});
app.all('/mcp',async c=>{
 if(!authenticate(c.req.header('Authorization')||null,c.env.OCP_API_KEY))return c.json({error:'Unauthorized'},401);
 const server=new McpServer({name:'ocp',version:'0.1.0'});
 const output=(v:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(v)}]});
 server.registerTool('list_conversations',{description:'List conversations for a participant',inputSchema:{participant_id:z.string()}},async({participant_id})=>output(await list(c.env.DB,participant_id)));
 server.registerTool('read_messages',{description:'Read messages since sequence number',inputSchema:{conversation_id:z.string(),participant_id:z.string(),after:z.number().int().nonnegative().default(0)}},async({conversation_id,participant_id,after})=>output(await history(c.env.DB,conversation_id,participant_id,after)));
 server.registerTool('post_message',{description:'Post a message as a participant',inputSchema:{conversation_id:z.string(),participant_id:z.string(),body:z.string()}},async({conversation_id,participant_id,body})=>output(await post(c.env.DB,conversation_id,participant_id,body)));
 server.registerTool('create_conversation',{description:'Create a conversation owned by a participant',inputSchema:{title:z.string(),participant_id:z.string()}},async({title,participant_id})=>output(await create(c.env.DB,title,participant_id)));
 const transport=new StreamableHTTPTransport({sessionIdGenerator:undefined});await server.connect(transport);
 return transport.handleRequest(c.req.raw);
});
app.get('/',c=>c.html(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>OCP v0.1</title><style>body{font:15px system-ui;background:#101827;color:#eef2f7;margin:0}main{max-width:900px;margin:40px auto;padding:24px}input,textarea,button{font:inherit;padding:10px;border-radius:8px;border:1px solid #4c5870;background:#1d2a40;color:white}button{cursor:pointer;background:#2763b7}section{background:#172237;padding:18px;border-radius:12px;margin-top:16px}#messages{height:330px;overflow:auto;white-space:pre-wrap}article{border-bottom:1px solid #34445b;padding:10px 0}small{color:#9bb1cb}textarea{width:95%}input{max-width:95%}</style></head><body><main><h1>OCP · Universal Conversations</h1><p>Persistent conversations across people, models and agents.</p><section><p><input id="key" type="password" placeholder="OCP API key"> <input id="pid" placeholder="Participant UUID"> <button onclick="load()">Connect</button></p><p><input id="title" placeholder="New conversation title"> <button onclick="createConversation()">Create</button></p><select id="rooms" onchange="read()"></select></section><section><div id="messages">Connect to read history.</div><textarea id="body" rows="3" placeholder="Message"></textarea><p><button onclick="send()">Send</button> <button onclick="read()">Refresh</button></p></section></main><script>const el=id=>document.getElementById(id);let rooms=[];async function api(path,method='GET',data){const r=await fetch('/api'+path,{method,headers:{Authorization:'Bearer '+el('key').value,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const j=await r.json();if(!r.ok)throw Error(j.error);return j}async function load(){try{rooms=await api('/conversations?participant_id='+encodeURIComponent(el('pid').value));el('rooms').innerHTML=rooms.map(x=>'<option value="'+x.id+'">'+x.title.replaceAll('<','&lt;')+'</option>').join('');await read()}catch(e){alert(e.message)}}async function createConversation(){try{await api('/conversations','POST',{title:el('title').value,participant_id:el('pid').value});await load()}catch(e){alert(e.message)}}async function read(){const id=el('rooms').value;if(!id)return;try{const ms=await api('/conversations/'+id+'/messages?participant_id='+encodeURIComponent(el('pid').value));el('messages').replaceChildren(...ms.map(m=>{const a=document.createElement('article');const h=document.createElement('small');h.textContent=m.participant_id+' · '+m.created_at+' · #'+m.seq;const p=document.createElement('p');p.textContent=m.body;a.append(h,p);return a}));}catch(e){alert(e.message)}}async function send(){try{await api('/conversations/'+el('rooms').value+'/messages','POST',{participant_id:el('pid').value,body:el('body').value});el('body').value='';await read()}catch(e){alert(e.message)}}</script></body></html>`));
export default app;

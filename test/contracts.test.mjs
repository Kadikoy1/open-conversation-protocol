import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const sql=readFileSync(new URL('../migrations/0001_init.sql',import.meta.url),'utf8');const src=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');
test('persistent core tables exist',()=>{for(const table of ['conversations','participants','memberships','messages','cursors','bridge_links'])assert.match(sql,new RegExp('CREATE TABLE IF NOT EXISTS '+table));});
test('deduplication constraint for bridge messages',()=>assert.match(sql,/UNIQUE\(source,external_id\)/));
test('MCP tools exposed',()=>{for(const name of ['list_conversations','read_messages','post_message','create_conversation'])assert.ok(src.includes(`registerTool('${name}'`));});
test('access control required on read and write',()=>{assert.match(src,/await requireMember\(db,cid,pid\)/);assert.match(src,/await requireMember\(db,cid,pid,true\)/);});
test('bridge rejects unmapped threads',()=>assert.match(src,/Thread not mapped/));

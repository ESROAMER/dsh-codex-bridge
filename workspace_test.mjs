import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {apply} from './index.js';
import {fakeHost,WORKSPACE_A} from './fake_host.mjs';
const dir=await mkdtemp(join(tmpdir(),'dsh-workspaces-'));
const stateDir=join(dir,'state');await mkdir(stateDir);
const path=join(dir,'project');await mkdir(path);const canonical=await realpath(path);
const host=fakeHost();let creates=0,handler;
host.ctx.workspaceRegistry.create=async(path,title)=>{
  const rows=host.ctx.workspaceRegistry.list(),prior=rows.find(w=>w.path===path);if(prior)return prior;
  creates++;const w={id:randomUUID(),path,title:title??basename(path),sessionIds:[],status:async()=> 'ok'};rows.push(w);return w;
};
const credentials={scoped:{workspaceIds:[WORKSPACE_A],allowWorkspaceCreate:true},wide:{workspaceIds:null},creator:{workspaceIds:null,allowWorkspaceCreate:true}};
const save=()=>writeFile(join(stateDir,'tokens.json'),JSON.stringify({version:1,tokens:Object.fromEntries(Object.entries(credentials).map(([alias,r])=>[alias,{alias,...r,hash:createHash('sha256').update(alias).digest('hex')}]))}));await save();
const mount=config=>apply({...host.ctx,webServer:{register(route){handler=route.handler;return ()=>{};}}},{stateDir,...config});mount();
const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
const call=async(token,route,body)=>{
  const res=await fetch(`http://127.0.0.1:${server.address().port}/codex-bridge${route}`,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,body:await res.json()};
};
let checks=0;const test=async(name,run)=>{await run();checks++;console.log('PASS:',name);};
const request={requestId:'create-one',path,title:'New project'};
try {
  await test('legacy all-workspace tokens do not gain create permission',async()=>assert.equal((await call('wide','/workspaces/create',request)).status,403));
  await test('selected scope cannot create even with permission flag',async()=>assert.equal((await call('scoped','/workspaces/create',request)).status,403));
  await test('capabilities reflect caller permissions',async()=>{assert.equal((await call('wide','/capabilities')).body.value.capabilities.workspaces.create,false);assert.equal((await call('creator','/capabilities')).body.value.capabilities.workspaces.create,true);});
  await test('relative paths and missing directories refused',async()=>{assert.equal((await call('creator','/workspaces/create',{...request,path:'relative'})).status,400);assert.equal((await call('creator','/workspaces/create',{...request,path:join(dir,'missing')})).status,400);});
  let workspaceId;
  await test('create registers canonical path and title',async()=>{const r=await call('creator','/workspaces/create',request);assert.equal(r.status,200);workspaceId=r.body.value.workspace.workspaceId;assert.equal(r.body.value.workspace.path,canonical);assert.equal(r.body.value.workspace.title,'New project');assert.equal(creates,1);});
  await test('retry returns same workspace',async()=>{const r=await call('creator','/workspaces/create',request);assert.equal(r.body.value.replayed,true);assert.equal(r.body.value.workspace.workspaceId,workspaceId);assert.equal(creates,1);});
  await test('request ID body changes conflict',async()=>assert.equal((await call('creator','/workspaces/create',{...request,title:'changed'})).status,409));
  await test('same path reused without retitling',async()=>{const r=await call('creator','/workspaces/create',{...request,requestId:'reuse',title:'Other title'});assert.equal(r.body.value.reused,true);assert.equal(r.body.value.workspace.title,'New project');assert.equal(creates,1);});
  await test('all scope discovers and dispatches to future workspace',async()=>{assert((await call('wide','/workspaces')).body.value.items.some(w=>w.workspaceId===workspaceId));assert(!(await call('scoped','/workspaces')).body.value.items.some(w=>w.workspaceId===workspaceId));assert.equal((await call('wide','/tasks/create',{requestId:'new-task',taskId:'new-task',workspaceId})).status,200);});
  await test('replay survives reload',async()=>{mount();await new Promise(r=>setTimeout(r,60));assert.equal((await call('creator','/workspaces/create',request)).body.value.replayed,true);});
  await test('revoked permission blocks cached replay',async()=>{credentials.creator.allowWorkspaceCreate=false;await save();assert.equal((await call('creator','/workspaces/create',request)).status,403);credentials.creator.allowWorkspaceCreate=true;await save();});
  await test('deployment allowlist and disable flag apply',async()=>{mount({workspacePaths:[join(dir,'other')]});assert.equal((await call('creator','/workspaces/create',request)).status,403);mount({allowWorkspaceCreate:false});assert.equal((await call('creator','/workspaces/create',request)).status,403);});
  console.log(`${checks} workspace checks passed`);
} finally {await new Promise(r=>server.close(r));assert.equal(dirname(resolve(dir)),resolve(tmpdir()));await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}

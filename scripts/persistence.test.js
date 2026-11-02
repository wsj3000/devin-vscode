const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dv-persist-test-"));
const bundle = path.join(TMP, "client.js");
esbuild.buildSync({ entryPoints: [path.join(ROOT, "src/acp/client.ts")], outfile: bundle,
  bundle: true, platform: "node", format: "cjs", logLevel: "error" });
const { AcpClient } = require(bundle);
const historyBundle = path.join(TMP, "history.js");
esbuild.buildSync({ entryPoints: [path.join(ROOT, "src/acp/replayHistory.ts")], outfile: historyBundle,
  bundle: true, platform: "node", format: "cjs", logLevel: "error" });
const { ReplayHistory } = require(historyBundle);
const backgroundBundle = path.join(TMP, "background.js");
esbuild.buildSync({ entryPoints: [path.join(ROOT, "src/acp/backgroundAgents.ts")], outfile: backgroundBundle,
  bundle: true, platform: "node", format: "cjs", logLevel: "error" });
const { scanBackgroundAgents, readBackgroundAgent, stopBackgroundAgent } = require(backgroundBundle);
const { persistenceLocation } = (() => {
  const file = path.join(TMP,"paths.js");
  esbuild.buildSync({entryPoints:[path.join(ROOT,"src/acp/persistentPaths.ts")],outfile:file,bundle:true,platform:"node",format:"cjs",logLevel:"error"});
  return require(file);
})();

const SOURCE = `
const fs=require('fs'),readline=require('readline');
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
const sid='s-'+process.pid;let pendingPrompt,terminal,mode;
fs.writeFileSync('agent.pid',String(process.pid));
const cb=(id,method,params)=>send({id,method,params:{sessionId:sid,...params}});
const answer=()=>{send({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'PERSIST_OK'}}}});send({id:pendingPrompt,result:{stopReason:'end_turn'}});pendingPrompt=null;};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),p=m.params||{};
 if(m.method==='initialize')return send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
 if(m.method==='session/new')return send({id:m.id,result:{sessionId:sid,configOptions:[]}});
 if(m.method==='session/load'){
  fs.appendFileSync('loads',p.sessionId+'\\n');
  if(p.sessionId==='large-history'){
   for(let i=0;i<80;i++)send({method:'session/update',params:{sessionId:p.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'history-'+i+'|'+('x'.repeat(1024*1024))}}}});
   return send({id:m.id,result:{sessionId:p.sessionId,configOptions:[]}});
  }
  if(fs.existsSync('allow-load'))return send({id:m.id,result:{sessionId:p.sessionId,configOptions:[]}});
  return send({id:m.id,error:{code:-1,message:'Must not reload a live agent'}});
 }
 if(m.method==='session/prompt'){
  mode=p.prompt[0].text;pendingPrompt=m.id;
  if(mode==='terminal')return cb('term','terminal/create',{command:JSON.stringify(process.execPath)+' -e '+JSON.stringify("require('fs').writeFileSync('started','yes');setTimeout(()=>{require('fs').writeFileSync('finished','yes');console.log('terminal done')},350)")});
  if(mode==='permission')return setTimeout(()=>cb('permission','session/request_permission',{toolCall:{title:'Write file'},options:[{optionId:'allow_once',kind:'allow_once',name:'Allow once'}]}),100);
  if(mode==='busy')return;
 }
 if(m.method==='session/cancel'&&pendingPrompt){send({id:pendingPrompt,result:{stopReason:'cancelled'}});pendingPrompt=null;return;}
 if(m.id==='term'){terminal=m.result.terminalId;cb('wait','terminal/wait_for_exit',{terminalId:terminal});return;}
 if(m.id==='wait'){cb('write','fs/write_text_file',{path:'agent-written.txt',content:'offline write\\n'});return;}
 if(m.id==='permission'){
  if(m.result?.outcome?.outcome!=='selected')return send({id:pendingPrompt,result:{stopReason:'cancelled'}});
  fs.writeFileSync('approved','yes');return answer();
 }
 if(m.id==='write')return answer();
 if(m.id!==undefined&&m.method)return send({id:m.id,result:{}});
});
process.stdin.on('end',()=>process.exit(0));
`;

async function until(condition, timeout=4000) {
 const end=Date.now()+timeout;
 while(Date.now()<end){if(await condition())return;await new Promise(r=>setTimeout(r,20));}
 assert.fail('condition did not become true');
}
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}

function fixture(t){
 const cwd=fs.mkdtempSync(path.join(TMP,'workspace-'));
 const js=path.join(cwd,'agent.js'),cli=path.join(cwd,'devin');
 fs.writeFileSync(js,SOURCE);fs.writeFileSync(cli,'#!/bin/sh\nexec '+JSON.stringify(process.execPath)+' '+JSON.stringify(js)+'\n');fs.chmodSync(cli,0o755);
 const clients=[];
 function client(sessionId,host={},script=path.join(ROOT,'dist/persistentAgent.js')){
  const c=new AcpClient({cliPath:cli,cwd,env:process.env,persistent:{script,sessionId,root:path.join(cwd,'state')}});
  c.setHost({requestPermission:()=>Promise.resolve({outcome:{outcome:'selected',optionId:'allow_once'}}),...host});
  c.start();clients.push(c);return c;
 }
 t.after(async()=>{
  for(const c of clients.reverse())await c.shutdown();
  for(const agent of await scanBackgroundAgents(path.join(cwd,'state'))){
   if(agent.cli===cli&&agent.cwd===cwd){
    try{await stopBackgroundAgent(agent);}catch(error){if(!['ESRCH','ENOENT','ECONNREFUSED'].includes(error.code))throw error;}
   }
  }
  const file=path.join(cwd,'agent.pid');
  if(fs.existsSync(file))await until(()=>!alive(Number(fs.readFileSync(file))),4000);
 });
 return {cwd,cli,client,base:path.join(cwd,'state')};
}
const posix={skip:process.platform==='win32'};
function legacyScript(compressed=false){
 const file=path.join(TMP,compressed?'old-cache-limit.js':'legacy-agent.js');
 if(!fs.existsSync(file)){
  // Advertise the old status shape without depending on Git history in CI.
  const current=fs.readFileSync(path.join(ROOT,'src/acp/persistentAgent.ts'),'utf8');
  const source=compressed
   ?current.replace('historyLimitBytes: HISTORY_LIMIT_BYTES','historyLimitBytes: 64 * 1024 * 1024').replace('new ReplayHistory()','new ReplayHistory(64 * 1024 * 1024)')
   :current.replace('historyEncoding: "deflate-blocks-v1"','legacyEncoding: "raw"');
  assert.notEqual(source,current);
  esbuild.buildSync({stdin:{contents:source,resolveDir:path.join(ROOT,'src/acp'),sourcefile:'legacy-agent.ts',loader:'ts'},outfile:file,bundle:true,platform:'node',format:'cjs',logLevel:'error'});
 }
 return file;
}

test('detached Devin executes terminals and file writes without a frontend',posix,async t=>{
 const h=fixture(t),a=h.client();await a.initialize();const s=await a.newSession(h.cwd);
 const originalPid=Number(fs.readFileSync(path.join(h.cwd,'agent.pid')));
 const prompt=a.prompt(s.sessionId,[{type:'text',text:'terminal'}]).catch(()=>{});
 await until(()=>fs.existsSync(path.join(h.cwd,'started')));
 await a.detach();await prompt;
 await until(()=>fs.existsSync(path.join(h.cwd,'agent-written.txt'))&&fs.readFileSync(path.join(h.cwd,'agent-written.txt'),'utf8')==='offline write\n');
 assert.equal(fs.readFileSync(path.join(h.cwd,'finished'),'utf8'),'yes');
 assert.equal(fs.readFileSync(path.join(h.cwd,'agent-written.txt'),'utf8'),'offline write\n');
 const b=h.client(s.sessionId),updates=[],edits=[];b.on('update',u=>updates.push(u));b.on('fileChanged',e=>edits.push(e));
 await b.initialize();await b.loadSession(s.sessionId,h.cwd);
 assert.equal(Number(fs.readFileSync(path.join(h.cwd,'agent.pid'))),originalPid);
 await until(()=>JSON.stringify(updates).includes('PERSIST_OK'));
 assert.equal(edits[0].original,null);
 assert.equal(edits[0].content,'offline write\n');
});

test('permission requested while detached is held and answered by the new frontend',posix,async t=>{
 const h=fixture(t),a=h.client();await a.initialize();const s=await a.newSession(h.cwd);
 const prompt=a.prompt(s.sessionId,[{type:'text',text:'permission'}]).catch(()=>{});
 await a.detach();await prompt;
 await new Promise(r=>setTimeout(r,180));
 assert.equal(fs.existsSync(path.join(h.cwd,'approved')),false);
 let resolve;const permission=new Promise(r=>{resolve=r;});let asked=0;
 const b=h.client(s.sessionId,{requestPermission:()=>{asked++;return permission;}});
 await b.initialize();const result=await b.loadSession(s.sessionId,h.cwd);
 assert.equal(result._meta['devin.persist/busy'],true);
 await until(()=>asked===1);
 assert.equal(fs.existsSync(path.join(h.cwd,'approved')),false);
 resolve({outcome:{outcome:'selected',optionId:'allow_once'}});
 await until(()=>fs.existsSync(path.join(h.cwd,'approved')));
});

test('a reattached running turn rejects duplicate prompts and can be cancelled',posix,async t=>{
 const h=fixture(t),a=h.client();await a.initialize();const s=await a.newSession(h.cwd);
 const prompt=a.prompt(s.sessionId,[{type:'text',text:'busy'}]).catch(()=>{});await a.detach();await prompt;
 const b=h.client(s.sessionId);await b.initialize();const result=await b.loadSession(s.sessionId,h.cwd);
 assert.equal(result._meta['devin.persist/busy'],true);
 await assert.rejects(b.prompt(s.sessionId,[{type:'text',text:'busy'}]),/still running/);
 let ended;b.on('turnEnded',r=>{ended=r;});b.cancel(s.sessionId);
 await until(()=>ended?.stopReason==='cancelled');
});

test('background metadata rejects symlinks instead of attaching another process',posix,()=>{
 const cwd=fs.mkdtempSync(path.join(TMP,'metadata-'));
 const location=persistenceLocation(cwd,'fake',undefined,path.join(TMP,'private'));
 const hash=require('crypto').createHash('sha256').update('bad-session').digest('hex').slice(0,24);
 fs.symlinkSync('/dev/null',path.join(location.root,'session-'+hash+'.json'));
 assert.throws(()=>persistenceLocation(cwd,'fake','bad-session',path.join(TMP,'private')),/metadata/);
});

test('history compression preserves snapshots and detects a real compressed limit',()=>{
 const history=new ReplayHistory();
 const event={method:'session/update',params:{text:'text with newline\nand Unicode 汉字'.repeat(3000)}};
 history.append(event);
 const snapshot=history.snapshot();
 history.append({method:'later'});
 assert.deepEqual([...history.frames(snapshot)].map(JSON.parse),[event]);
 assert.deepEqual([...history.frames(history.snapshot())].map(JSON.parse),[event,{method:'later'}]);
 assert.ok(history.compressedBytes<history.rawBytes/10);
 const limited=new ReplayHistory(100);
 limited.append({text:require('crypto').randomBytes(10000).toString('base64')});
 limited.snapshot();
 assert.equal(limited.overflow,true);
 assert.ok(limited.compressedBytes<=100);
});

test('a history above 64 MiB reattaches completely through a slow frontend',posix,async t=>{
 const h=fixture(t),a=h.client('large-history');await a.initialize();
 let count=0;a.on('update',()=>count++);
 await a.loadSession('large-history',h.cwd);
 assert.equal(count,80);
 const pid=Number(fs.readFileSync(path.join(h.cwd,'agent.pid')));
 await a.detach();
 const b=h.client('large-history');await b.initialize();
 const indices=[];b.on('update',u=>{
  const text=u.update.content.text;
  indices.push(Number(text.slice(8,text.indexOf('|'))));
  assert.equal(text.length,1024*1024+('history-'+indices.at(-1)+'|').length);
 });
 b.child.stdout.pause();
 const restoring=b.loadSession('large-history',h.cwd);
 await until(()=>b.child.stdout.readableLength>0);
 b.child.stdout.resume();
 await restoring;
 assert.deepEqual(indices,Array.from({length:80},(_,i)=>i));
 const status=await b.rpc('_devin.persist/status',{},1000);
 assert.equal(status.agentPid,pid);
 assert.ok(status.historyRawBytes>64*1024*1024);
 assert.ok(status.historyBytes<1024*1024);
 assert.equal(status.historyOverflow,false);
 assert.equal(fs.readFileSync(path.join(h.cwd,'loads'),'utf8'),'large-history\n','warm replay never reloads the native session');
});

test('an idle legacy broker upgrades and reopens its stored conversation',posix,async t=>{
 const h=fixture(t),a=h.client(undefined,{},legacyScript());
 await a.initialize();const session=await a.newSession(h.cwd);
 const pid=Number(fs.readFileSync(path.join(h.cwd,'agent.pid')));
 fs.writeFileSync(path.join(h.cwd,'allow-load'),'yes');
 await a.detach();
 const b=h.client(session.sessionId);await b.initialize();await b.loadSession(session.sessionId,h.cwd);
 const status=await b.rpc('_devin.persist/status',{},1000);
 assert.equal(status.historyEncoding,'deflate-blocks-v1');
 assert.notEqual(status.agentPid,pid);
 assert.equal(status.sessionId,session.sessionId);
});

test('a legacy broker with a running turn is reattached without restarting it',posix,async t=>{
 const h=fixture(t),a=h.client(undefined,{},legacyScript());
 await a.initialize();const session=await a.newSession(h.cwd);
 const pid=Number(fs.readFileSync(path.join(h.cwd,'agent.pid')));
 const prompt=a.prompt(session.sessionId,[{type:'text',text:'busy'}]).catch(()=>{});
 await a.detach();await prompt;
 const b=h.client(session.sessionId);await b.initialize();
 const loaded=await b.loadSession(session.sessionId,h.cwd);
 const status=await b.rpc('_devin.persist/status',{},1000);
 assert.equal(status.agentPid,pid);
 assert.equal(loaded._meta['devin.persist/busy'],true);
 assert.equal(status.historyEncoding,undefined);
 b.cancel(session.sessionId);
 await until(async()=>!(await b.rpc('_devin.persist/status',{},1000)).busy);
});

test('an idle compressed broker with the old limit upgrades to 256 MiB',posix,async t=>{
 const h=fixture(t),a=h.client(undefined,{},legacyScript(true));
 await a.initialize();const session=await a.newSession(h.cwd);
 const old=await a.rpc('_devin.persist/status',{},1000);
 assert.equal(old.historyEncoding,'deflate-blocks-v1');
 assert.equal(old.historyLimitBytes,64*1024*1024);
 fs.writeFileSync(path.join(h.cwd,'allow-load'),'yes');await a.detach();
 const b=h.client(session.sessionId);await b.initialize();await b.loadSession(session.sessionId,h.cwd);
 const updated=await b.rpc('_devin.persist/status',{},1000);
 assert.equal(updated.historyLimitBytes,256*1024*1024);
 assert.notEqual(updated.agentPid,old.agentPid);
 assert.equal(updated.sessionId,session.sessionId);
});

test('passive background discovery preserves ownership and can stop a detached process',posix,async t=>{
 const h=fixture(t),a=h.client();await a.initialize();const session=await a.newSession(h.cwd);
 const [idle]=await scanBackgroundAgents(h.base);
 assert.equal(idle.sessionId,session.sessionId);assert.equal(idle.busy,false);
 await assert.rejects(stopBackgroundAgent(idle),/another window/);
 await assert.rejects(stopBackgroundAgent({...idle,agentPid:idle.agentPid+1}),/changed/);
 const prompt=a.prompt(session.sessionId,[{type:'text',text:'busy'}]).catch(()=>{});
 let running;
 await until(async()=>{[running]=await scanBackgroundAgents(h.base);return running?.busy;});
 assert.equal(running.agentPid,idle.agentPid,'status probes never replace or take over the agent');
 await a.detach();await prompt;
 await stopBackgroundAgent(running);
 assert.deepEqual(await scanBackgroundAgents(h.base),[]);
 assert.equal(fs.existsSync(path.join(h.cwd,'loads')),false,'discovery never loads native session history');
});

test('passive discovery sees waiting input without answering it and rejects socket symlinks',posix,async t=>{
 const h=fixture(t),a=h.client();await a.initialize();const session=await a.newSession(h.cwd);
 const prompt=a.prompt(session.sessionId,[{type:'text',text:'permission'}]).catch(()=>{});
 await a.detach();await prompt;
 let waiting;
 await until(async()=>{[waiting]=await scanBackgroundAgents(h.base);return waiting?.awaitingInput===1;});
 assert.equal(waiting.sessionId,session.sessionId);
 assert.equal(fs.existsSync(path.join(h.cwd,'approved')),false);
 const link=path.join(path.dirname(waiting.socket),'0000000000000000.sock');fs.symlinkSync(waiting.socket,link);
 await assert.rejects(readBackgroundAgent(link),/permissions/);
 assert.equal((await scanBackgroundAgents(h.base)).length,1);
 await stopBackgroundAgent(waiting);
});

test.after(()=>fs.rmSync(TMP,{recursive:true,force:true}));

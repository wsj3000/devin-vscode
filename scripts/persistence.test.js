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
 if(m.method==='session/load')return send({id:m.id,error:{code:-1,message:'Must not reload a live agent'}});
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
 function client(sessionId,host={}){
  const c=new AcpClient({cliPath:cli,cwd,env:process.env,persistent:{script:path.join(ROOT,'dist/persistentAgent.js'),sessionId,root:path.join(TMP,'state')}});
  c.setHost({requestPermission:()=>Promise.resolve({outcome:{outcome:'selected',optionId:'allow_once'}}),...host});
  c.start();clients.push(c);return c;
 }
 t.after(async()=>{
  for(const c of clients.reverse())await c.shutdown();
  const file=path.join(cwd,'agent.pid');
  if(fs.existsSync(file))await until(()=>!alive(Number(fs.readFileSync(file))),4000);
 });
 return {cwd,cli,client};
}
const posix={skip:process.platform==='win32'};

test('detached Devin executes terminals and file writes without a frontend',posix,async t=>{
 const h=fixture(t),a=h.client();await a.initialize();const s=await a.newSession(h.cwd);
 const originalPid=Number(fs.readFileSync(path.join(h.cwd,'agent.pid')));
 const prompt=a.prompt(s.sessionId,[{type:'text',text:'terminal'}]).catch(()=>{});
 await until(()=>fs.existsSync(path.join(h.cwd,'started')));
 await a.detach();await prompt;
 await until(()=>fs.existsSync(path.join(h.cwd,'agent-written.txt')));
 assert.equal(fs.readFileSync(path.join(h.cwd,'finished'),'utf8'),'yes');
 assert.equal(fs.readFileSync(path.join(h.cwd,'agent-written.txt'),'utf8'),'offline write\n');
 const b=h.client(s.sessionId),updates=[],edits=[];b.on('update',u=>updates.push(u));b.on('fileChanged',e=>edits.push(e));
 await b.initialize();await b.loadSession(s.sessionId,h.cwd);
 assert.equal(Number(fs.readFileSync(path.join(h.cwd,'agent.pid'))),originalPid);
 assert.ok(JSON.stringify(updates).includes('PERSIST_OK'));
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

test.after(()=>fs.rmSync(TMP,{recursive:true,force:true}));

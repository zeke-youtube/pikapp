import test from 'node:test'; import assert from 'node:assert/strict'; import worker from '../worker/index.js';
globalThis.btoa ||= s=>Buffer.from(s,'binary').toString('base64'); globalThis.atob ||= s=>Buffer.from(s,'base64').toString('binary');
class KV { constructor(){this.data=new Map()} async get(k){return this.data.get(k)??null} async put(k,v){this.data.set(k,v)} async delete(k){this.data.delete(k)} }
const env=()=>({PIKAPP_KV:new KV(),AI:{run:async()=>({response:'safe'})},ASSETS:{fetch:()=>new Response('asset')}}), req=(path,method='GET',body,cookie,headers={})=>new Request(`https://test${path}`,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...headers},body:body&&JSON.stringify(body)}), call=(e,p,m,b,c,h)=>worker.fetch(req(p,m,b,c,h),e);
async function user(e,name){const r=await call(e,'/api/auth/register','POST',{username:name,email:`${name}@example.com`,displayName:name,password:'long-password-123'});return{data:await r.clone().json(),cookie:`pikapp_session=${r.headers.get('set-cookie').match(/pikapp_session=([^;]+)/)[1]}`}}
async function claim(e,u,local){return call(e,'/api/mail/address','POST',{localPart:local},u.cookie)}
test('mail requires PikApp authentication and validates permanent claims',async()=>{const e=env(),a=await user(e,'alice'),b=await user(e,'bobby');assert.equal((await call(e,'/api/mail/inbox')).status,401);assert.equal((await call(e,'/api/mail/send','POST',{})).status,401);assert.equal((await claim(e,a,'Alice.Mail')).status,201);assert.equal((await claim(e,b,'alice.mail')).status,409);assert.equal((await claim(e,a,'another')).status,409);for(const value of ['ab','admin','.abc','abc.','a..b','bad-name','a'.repeat(33)])assert.notEqual((await claim(e,await user(e,`u${crypto.randomUUID().slice(0,8)}`),value)).status,201);assert.deepEqual(JSON.parse(await e.PIKAPP_KV.get('mail:address:alice.mail')).id,a.data.user.id)});
test('internal mail is private, paginated, read-aware, and sender cannot be spoofed',async()=>{const e=env(),a=await user(e,'alice'),b=await user(e,'bobby');await claim(e,a,'alice');await claim(e,b,'bobby');assert.equal((await call(e,'/api/mail/send','POST',{to:'x@gmail.com',subject:'x',text:'x'},a.cookie)).status,400);assert.equal((await call(e,'/api/mail/send','POST',{from:'fake@pikamail.com',to:'bobby@pikamail.com',subject:'x',text:'x'},a.cookie)).status,400);const sent=await call(e,'/api/mail/send','POST',{to:'bobby@pikamail.com',subject:'Hello',text:'<img src=x onerror=alert(1)>'},a.cookie),mid=(await sent.json()).messageId;const inbox=await (await call(e,'/api/mail/inbox?limit=1','GET',null,b.cookie)).json();assert.equal(inbox.messages[0].unread,true);assert.equal(inbox.messages[0].preview,'<img src=x onerror=alert(1)>');assert.equal((await call(e,`/api/mail/messages/${mid}`,'GET',null,a.cookie)).status,200);const c=await user(e,'carol');assert.equal((await call(e,`/api/mail/messages/${mid}`,'GET',null,c.cookie)).status,404);await call(e,`/api/mail/messages/${mid}`,'GET',null,b.cookie);assert.equal((await (await call(e,'/api/mail/inbox','GET',null,b.cookie)).json()).messages[0].unread,false);assert.equal((await call(e,`/api/mail/messages/${mid}`,'PATCH',{unread:true},b.cookie)).status,200)});
test('application owners self-claim one globally unique permanent sender and API delivery cannot spoof it',async()=>{
  const e=env(),owner=await user(e,'owner'),recipient=await user(e,'recipient'),stranger=await user(e,'stranger'),personal=await user(e,'personal');
  await claim(e,recipient,'recipient'); await claim(e,personal,'personal.mail');
  const made=await call(e,'/api/mail/developer/apps','POST',{name:'Verifier',ownerId:'fake'},owner.cookie),app=(await made.json()).app;
  const other=(await (await call(e,'/api/mail/developer/apps','POST',{name:'Other'},stranger.cookie)).json()).app;
  assert.equal(app.ownerId,owner.data.user.id);
  assert.equal((await call(e,`/api/mail/developer/apps/${app.id}/sender`,'POST',{localPart:'sender'},null)).status,401);
  assert.equal((await call(e,`/api/mail/developer/apps/${app.id}/sender`,'POST',{localPart:'sender'},stranger.cookie)).status,404);
  for(const localPart of ['ab','admin','.bad','bad-name']) assert.equal((await call(e,`/api/mail/developer/apps/${app.id}/sender`,'POST',{localPart},owner.cookie)).status,400);
  assert.equal((await call(e,`/api/mail/developer/apps/${app.id}/sender`,'POST',{localPart:'PERSONAL.Mail'},owner.cookie)).status,409);
  const claimed=await call(e,`/api/mail/developer/apps/${app.id}/sender`,'POST',{localPart:'App.Mail'},owner.cookie),claimedApp=(await claimed.json()).app;
  assert.equal(claimed.status,201); assert.equal(claimedApp.apiEmail,'app.mail@pikamail.com'); assert.deepEqual(claimedApp.senders,['app.mail@pikamail.com']);
  assert.equal((await claim(e,await user(e,'lateruser'),'app.mail')).status,409);
  assert.equal((await call(e,`/api/mail/developer/apps/${other.id}/sender`,'POST',{localPart:'APP.MAIL'},stranger.cookie)).status,409);
  assert.equal((await call(e,`/api/mail/developer/apps/${app.id}/sender`,'POST',{localPart:'different'},owner.cookie)).status,409);
  const auditIds=JSON.parse(await e.PIKAPP_KV.get('mail:audit:index')),audit=JSON.parse(await e.PIKAPP_KV.get(`mail:audit:${auditIds[0]}`));
  assert.equal(audit.action,'developer_sender_claimed'); assert.equal(audit.metadata.ownerUserId,owner.data.user.id); assert.equal(audit.metadata.senderAddress,'app.mail@pikamail.com');
  const keyResponse=await call(e,`/api/mail/developer/apps/${app.id}/key`,'POST',{},owner.cookie),key=(await keyResponse.json()).key;
  assert.match(key,/^pm_live_/); assert.equal(JSON.parse(await e.PIKAPP_KV.get(`mail:app:${app.id}`)).keyHash===key,false);
  assert.equal((await call(e,'/api/mail/v1/send','POST',{from:'spoof@pikamail.com',to:'recipient@pikamail.com',subject:'Code',text:'123'},null,{authorization:`Bearer ${key}`})).status,403);
  assert.equal((await call(e,'/api/mail/v1/send','POST',{from:'app.mail@pikamail.com',to:'recipient@pikamail.com',subject:'Code',text:'123'},null,{authorization:`Bearer ${key}`})).status,201);
  assert.equal((await call(e,'/api/mail/v1/send','POST',{to:'recipient@pikamail.com',subject:'Code 2',text:'456'},null,{authorization:`Bearer ${key}`})).status,201);
  const inbox=(await (await call(e,'/api/mail/inbox','GET',null,recipient.cookie)).json()).messages;
  assert.equal(inbox.length,2); assert.ok(inbox.every(message=>message.from==='app.mail@pikamail.com'));
});

test('an application without an API email cannot send, while key regeneration and revocation remain secure',async()=>{
  const e=env(),owner=await user(e,'keyowner'),recipient=await user(e,'keyrecipient'); await claim(e,recipient,'keyrecipient');
  const app=(await (await call(e,'/api/mail/developer/apps','POST',{name:'No sender'},owner.cookie)).json()).app;
  const key=(await (await call(e,`/api/mail/developer/apps/${app.id}/key`,'POST',{},owner.cookie)).json()).key;
  assert.equal((await call(e,'/api/mail/v1/send','POST',{to:'keyrecipient@pikamail.com',subject:'x',text:'x'},null,{authorization:`Bearer ${key}`})).status,409);
  const replacement=(await (await call(e,`/api/mail/developer/apps/${app.id}/key`,'POST',{},owner.cookie)).json()).key;
  assert.equal((await call(e,'/api/mail/v1/send','POST',{},null,{authorization:`Bearer ${key}`})).status,401);
  await call(e,`/api/mail/developer/apps/${app.id}/key`,'DELETE',null,owner.cookie);
  assert.equal((await call(e,'/api/mail/v1/send','POST',{},null,{authorization:`Bearer ${replacement}`})).status,401);
});

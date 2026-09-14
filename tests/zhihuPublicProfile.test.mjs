import assert from 'node:assert/strict';
import { fetchPublicUrlToken } from '../src/auth/zhihuPublicProfile.mjs';
import { createZhihuOAuth, ownerFromProfile } from '../src/auth/zhihuOAuth.mjs';
import { createInMemoryFollowingRepository } from '../src/ecosystem/following/repository.mjs';
const hash = '0123456789abcdef0123456789abcdef';
const uid = '1234567890123456789';
const config = { appId:'413', appKey:'private-app-key', redirectUri:'https://story.example/auth/callback', origin:'https://story.example' };
const response = () => ({ headers:{}, getHeader(k){return this.headers[k]}, setHeader(k,v){this.headers[k]=v} });
async function login({member, profile = {uid, fullname:'Example', hash_id:hash, url:`https://openapi.zhihu.com/users/${uid}`}, duringMember} = {}) {
 const calls=[]; const repo=createInMemoryFollowingRepository();
 let oauth;
 oauth=createZhihuOAuth(config,{onLogin:owner=>repo.rememberAccount(owner),fetchImpl:async (url,options)=>{
  calls.push({url,options});
  if(url.endsWith('/access_token'))return Response.json({access_token:'private-user-token',expires_in:3600});
  if(url==='https://openapi.zhihu.com/user')return new Response(JSON.stringify(profile).replace(`"${uid}"`,uid));
  assert.equal(url,`https://www.zhihu.com/api/v4/members/${hash}?include=url_token`);
  assert.deepEqual(options.headers,{accept:'application/json'});
  assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
  if(duringMember)await duringMember(oauth, { headers: { cookie: flowCookie, origin: config.origin } });
  return member ? member(options) : Response.json({id:hash,url_token:'custom-public-slug'});
 }});
 const start=response();const location=new URL(oauth.start({headers:{}},start,new URL('https://story.example/auth/login')));
 const flowCookie=start.headers['Set-Cookie'][0].split(';')[0];
 const finish=response();
 await oauth.callback({headers:{cookie:flowCookie}},finish,new URL(config.redirectUri+'?code=test-code&state='+location.searchParams.get('state')));
 const cookie=finish.headers['Set-Cookie'].find(s=>s.startsWith('__Host-story_outside_session=')).split(';')[0];
 const req={headers:{cookie}};
 return {owner:oauth.owner(req),status:oauth.status(req),repo,calls};
}
{
 const {owner,status,repo,calls}=await login();
 assert.equal(owner.user_uuid,ownerFromProfile({uid},'413').user_uuid,'preserves the full 19-digit stable identity');
 assert.equal(owner.url_token,'custom-public-slug');
 assert.equal(repo.resolveAccount('custom-public-slug'),owner.user_uuid);
 assert.equal(calls.length,3);
 assert.equal(status.authenticated,true);
 for(const secret of ['private-user-token','private-app-key',hash,'custom-public-slug'])assert.ok(!JSON.stringify(status).includes(secret));
}
for(const member of [
 ()=>Response.json({id:'f'.repeat(32),url_token:'someone-else'}),
 ()=>Response.json({url_token:'missing-id'}),
 ()=>Response.json({id:hash,url_token:'../../escape'}),
 ()=>Response.json({id:hash,url_token:123}),
 ()=>new Response('blocked',{status:403}),
 ()=>new Response('',{status:302,headers:{location:'https://evil.example'}}),
 ()=>new Response('not-json'),
 ()=>new Response('x'.repeat(65537)),
 ()=>{throw new Error('private-user-token')},
]){
 const {owner,status,repo}=await login({member});
 assert.equal(status.authenticated,true,'public lookup failure does not block gameplay');
 assert.equal(owner.url_token,undefined,'failure must never bind another player');
 assert.equal(repo._exportSnapshot().accounts.length,0);
}
for(const invalid of [undefined,null,123,'../../evil','https://evil.example', '1234567890123456789', 'z'.repeat(32)]){
 let called=false;
 assert.equal(await fetchPublicUrlToken(invalid,{fetchImpl:()=>{called=true}}),null);
 assert.equal(called,false);
}
for (const cancel of ['logout', 'restart']) {
 await assert.rejects(login({duringMember: async (oauth, request) => {
  if(cancel==='logout')oauth.logout(request,response());
  else oauth.start(request,response(),new URL('https://story.example/auth/login'));
 }}), {code:'oauth_state_invalid'}, 'a public profile request cannot resurrect a cancelled login');
}
{
 const direct=await login({profile:{uid,url:'https://www.zhihu.com/people/existing-slug',hash_id:hash}});
 assert.equal(direct.calls.length,2,'existing /people/ profiles do not need another request');
 assert.equal(direct.repo.resolveAccount('existing-slug'),direct.owner.user_uuid);
}
{
 let aborted=false;
 await assert.rejects(fetchPublicUrlToken(hash,{timeoutMs:10,fetchImpl:(_url,options)=>new Promise((_,reject)=>{
  const keepAlive=setTimeout(()=>reject(new Error('timeout did not abort')),500);
  options.signal.addEventListener('abort',()=>{clearTimeout(keepAlive);aborted=true;reject(options.signal.reason)},{once:true});
 })}));
 assert.equal(aborted,true);
}
console.log('OAuth real resource URL -> verified public identity, activity registration, privacy, bounded failure, legacy URL compatibility: PASS');

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/routes.js'),'utf8');
function setup(checkError){
  const routes={},writes=[],calls=[];
  const app={get(p,...f){routes[`GET ${p}`]=f;},post(p,...f){routes[`POST ${p}`]=f;},put(p,...f){routes[`PUT ${p}`]=f;},delete(p,...f){routes[`DELETE ${p}`]=f;}};
  const mocks={
    luxon:{DateTime:{now:()=>({setZone:()=>({isValid:true})})}},
    './db':{query:async(sql)=>{writes.push(sql);return [];},one:async()=>null},
    './domain':{ensureUser:async()=>({id:10}),profile:async()=>({nickname:'新的昵称'}),healthDate:async()=>({health_date:'2026-10-10'})},
    './ai':{aiConfigured:()=>true,hitsSafetyBoundary:()=>false,recommend:async()=>{calls.push('ai');return {};},},
    './ugc':{checkText:async(x)=>{calls.push(`ugc:${x.scene}`);if(checkError)throw checkError;return {outcome:'pass'};}},
    './cloudbase':{cloudbaseApp:()=>null},
    './admin':{basicAuth:(_req,_res,next)=>next(),dashboard:()=>{}},
    './advisor':{advisor:async()=>({})}
  };
  const m={exports:{}};
  vm.runInThisContext('(function(require,module,exports){'+source+'\n})')((id)=>{if(!(id in mocks))throw Error('unknown dependency '+id);return mocks[id];},m,m.exports);
  m.exports.register(app);
  return {routes,writes,calls};
}
async function call(stack,body){
  const req={headers:{'x-wx-openid':'test-openid'},body,requestId:'test-request'};
  let value=null,error=null;
  const res={status(n){this.code=n;return this;},json(x){value=x;return this;}};
  await new Promise((resolve,reject)=>stack[0](req,res,e=>e?reject(e):resolve()));
  await stack[1](req,res,e=>{error=e;});
  return {value,error};
}
const denial=()=>Object.assign(new Error('输入内容未通过平台安全检测，请修改后重试'),{code:'ugc_content_blocked',status:422});

test('nickname rejected before profile write',async()=>{
  const a=setup(denial());
  const out=await call(a.routes['PUT /me/profile'],{nickname:'用户输入'});
  assert.equal(out.error?.code,'ugc_content_blocked');
  assert.ok(a.calls.includes('ugc:1'));
  assert.equal(a.writes.some(sql=>sql.includes('INSERT INTO healtools_user_profiles')),false);
});

test('free-text AI request rejected before generation, usage tracking or plan persistence',async()=>{
  const a=setup(denial());
  const out=await call(a.routes['POST /ai/recommend'],{text:'今天感觉一般'});
  assert.equal(out.error?.code,'ugc_content_blocked');
  assert.deepEqual(a.calls,['ugc:2']);
  assert.equal(a.writes.some(sql=>sql.includes('healtools_daily_cards')||sql.includes('healtools_usage_events')),false);
});

test('nickname passes and can save after moderation',async()=>{
  const a=setup(null);
  const out=await call(a.routes['PUT /me/profile'],{nickname:'新的昵称'});
  assert.equal(out.error,null);
  assert.equal(out.value?.profile?.nickname,'新的昵称');
  assert.equal(a.writes.filter(sql=>sql.includes('INSERT INTO healtools_user_profiles')).length,1);
});

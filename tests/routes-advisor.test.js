'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const script=fs.readFileSync(path.join(__dirname,'../src/routes.js'),'utf8');
function makeApp({failAdvisor=false}={}) {
 const handlers={};let adviceCalls=0, saves=0;
 const app={get(path,...fns){handlers[`GET ${path}`]=fns;},post(path,...fns){handlers[`POST ${path}`]=fns;},put(path,...fns){handlers[`PUT ${path}`]=fns;},delete(path,...fns){handlers[`DELETE ${path}`]=fns;}};
 const mocks={
  luxon:{DateTime:{now:()=>({setZone:()=>({isValid:true})})}},
  './db':{query:async(sql)=>sql.includes('SELECT record_uuid,tool_type')?[{record_uuid:'12345678-1234-4123-8123-123456789abc',tool_type:'sleep'}]:{affectedRows:1},one:async()=>({n:1})},
  './domain':{ensureUser:async()=>({id:3}),healthDate:async()=>({health_date:'2026-10-09'}),submitRecord:async(_id,_type,p)=>{saves++;return {record_id:p.record_id,server_version:1,duplicate:p.record_id==='already',star_delta:0};},starSummary:async()=>({total_star:0})},
  './ai':{aiConfigured:()=>true},
  './cloudbase':{cloudbaseApp:()=>{}},
  './admin':{basicAuth:(_req,_res,next)=>next(),dashboard:()=>{}},
  './advisor':{advisor:async()=>{adviceCalls++;if(failAdvisor)throw new Error('mock model outage');return {available:true,items:[{type:'sleep',text:'test'}],provider:'cloudbase_ai'};}}
 };
 const mod={exports:{}};
 vm.runInThisContext('(function(require,module,exports){'+script+'\n})')((id)=>{if(!mocks[id])throw Error('unknown import '+id);return mocks[id];},mod,mod.exports);
 mod.exports.register(app);
 return {handlers,get adviceCalls(){return adviceCalls;},get saves(){return saves;}};
}
async function invoke(route,mutations){
 const req={headers:{'x-wx-openid':'test-openid'},body:{mutations},requestId:'testid'};
 let result;
 const res={json(x){result=x;return this;},status(){return this;}};
 const stack=route.handlers['POST /sync/batch'];assert.equal(stack.length,2);
 await new Promise((resolve,reject)=>stack[0](req,res,e=>e?reject(e):resolve()));
 await stack[1](req,res,e=>{if(e)throw e;});
 return result;
}
test('sync batch triggers exactly one advice for changed wellness records',async()=>{
 const a=makeApp();const resp=await invoke(a,[{resource:'sleep_diary',mutation_id:'m1',record_id:'m1',payload:{}},{resource:'diet_checkin',mutation_id:'m2',record_id:'m2',payload:{}},{resource:'breathing_session',mutation_id:'m3',record_id:'m3',payload:{}}]);
 assert.equal(a.saves,3);assert.equal(a.adviceCalls,1);assert.equal(resp.advisor_insight.provider,'cloudbase_ai');assert.equal(resp.results.length,3);
});
test('duplicate wellness record also refreshes a missing insight cache',async()=>{
 const a=makeApp();const resp=await invoke(a,[{resource:'sleep_diary',mutation_id:'already',record_id:'already',payload:{}},{resource:'breathing_session',mutation_id:'b1',record_id:'b1',payload:{}}]);
 assert.equal(a.adviceCalls,1);assert.equal(resp.advisor_insight.provider,'cloudbase_ai');
});
test('model failure does not lose committed sync records',async()=>{
 const a=makeApp({failAdvisor:true});const resp=await invoke(a,[{resource:'emotion_assessment',mutation_id:'m2',record_id:'m2',payload:{}}]);
 assert.equal(a.adviceCalls,1);assert.equal(resp.results[0].status,'applied');assert.ok(resp.advisor_error);
});

async function invokeDirect(route, path, recordId){
 const req={headers:{'x-wx-openid':'test-openid'},body:{record_id:recordId,health_date:'2026-10-10',quality:3,bedtime_text:'23:30',wake_time_text:'07:30'},requestId:'direct-test'};
 let result;
 const res={json(x){result=x;return this;},status(){return this;}};
 const stack=route.handlers['POST '+path];assert.equal(stack.length,2);
 await new Promise((resolve,reject)=>stack[0](req,res,e=>e?reject(e):resolve()));
 await stack[1](req,res,e=>{if(e)throw e;});
 return result;
}
test('direct sleep diary returns the same UUID and triggers adviser only after save',async()=>{
 const a=makeApp(),id='12345678-1234-4123-8123-123456789abc';
 const out=await invokeDirect(a,'/sleep/diaries',id);
 assert.equal(out.record_id,id);
 assert.equal(a.saves,1);assert.equal(a.adviceCalls,1);
 assert.equal(out.advisor_insight.provider,'cloudbase_ai');
});
test('direct breathing session returns UUID without adviser inference',async()=>{
 const a=makeApp(),id='12345678-1234-4123-8123-123456789abd';
 const out=await invokeDirect(a,'/breathing/sessions',id);
 assert.equal(out.record_id,id);assert.equal(a.saves,1);assert.equal(a.adviceCalls,0);
});

test('record confirmation returns UUID existence without sensitive payload',async()=>{
 const a=makeApp();const id='12345678-1234-4123-8123-123456789abc', missing='12345678-1234-4123-8123-123456789abd';
 const req={headers:{'x-wx-openid':'test-openid'},body:{record_ids:[id,missing]},requestId:'confirm-test'};
 let data;
 const res={json(x){data=x;return this;},status(){return this;}};
 const stack=a.handlers['POST /records/confirm'];
 await new Promise((resolve,reject)=>stack[0](req,res,e=>e?reject(e):resolve()));
 await stack[1](req,res,e=>{if(e)throw e;});
 assert.deepEqual(data.records,[{record_id:id,exists:true,tool:'sleep'},{record_id:missing,exists:false,tool:null}]);
 assert.equal('payload_json' in data,false);
});

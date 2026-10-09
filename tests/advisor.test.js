'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.resolve(__dirname, '..', 'src');
const dbPath = path.join(root, 'db.js');
const domainPath = path.join(root, 'domain.js');
const aiPath = path.join(root, 'ai.js');
const advisorPath = path.join(root, 'advisor.js');
let date = '2026-10-09';
let aiCount = 0;
let records = [];
const cached = new Map();
const clone = x => x == null ? null : JSON.parse(JSON.stringify(x));
function key(user, day){return `${user}:${day}`;}
const db = {
  async one(sql, params){
    if(sql.includes('FROM healtools_task_records'))return clone(records.filter(x=>x.tool_type===params[1]).slice(-1)[0]);
    if(sql.includes('FROM healtools_advisor_insights')) return clone(cached.get(key(params[0],params[1])));
    throw Error('unexpected SELECT '+sql);
  },
  async query(sql, params){
    if(sql.includes('INSERT IGNORE INTO healtools_advisor_insights')){
      const k=key(params[0],params[1]);if(cached.has(k))return {affectedRows:0};
      cached.set(k,{source_hash:params[2],provider:'generating',content_json:'{}',generated_at:'2026-10-09 00:00:00'});
      return {affectedRows:1};
    }
    if(sql.includes('UPDATE healtools_advisor_insights SET source_hash=')){
      const k=key(params[1],params[2]),old=cached.get(k);
      if(!old||old.source_hash!==params[3])return {affectedRows:0};
      if(old.provider==='generating'&&old.source_hash===params[0])return {affectedRows:0};
      cached.set(k,{...old,source_hash:params[0],provider:'generating',content_json:'{}'});return {affectedRows:1};
    }
    if(sql.includes('UPDATE healtools_advisor_insights SET provider=?,content_json=?')){
      const k=key(params[2],params[3]),old=cached.get(k);
      if(old?.provider!=='generating'||old.source_hash!==params[4])return {affectedRows:0};
      cached.set(k,{...old,provider:params[0],content_json:params[1]});return {affectedRows:1};
    }
    if(sql.includes("SET provider='error'"))return {affectedRows:1};
    throw Error('unexpected QUERY '+sql);
  }
};
for(const [name,mod] of [[dbPath,db],[domainPath,{healthDate:async()=>({health_date:date})}],[aiPath,{generateLifestyleInsight:async(ctx)=>{aiCount++;await new Promise(r=>setTimeout(r,25));return Object.fromEntries(['sleep','diet','emotion','overall'].map(x=>[x,`AI response ${aiCount} for ${x}`]));}}]]){
  require.cache[name]={id:name,filename:name,loaded:true,exports:mod};
}
const { advisor, fingerprint } = require(advisorPath);
test('initial no data gives no AI call',async()=>{
  const a=await advisor(14);
  assert.equal(a.available,false);assert.equal(a.provider,'no_data');assert.equal(aiCount,0);
});
test('first record generates, same day cached, new record invalidates, next day refresh',async()=>{
  records=[{record_uuid:'r1',tool_type:'sleep',health_date:date,payload_json:JSON.stringify({quality:2,bedtime_text:'23:30',wake_time_text:'07:30'})}];
  const a=await advisor(14);assert.equal(a.available,true);assert.equal(a.items[0].type,'sleep');assert.equal(a.provider,'cloudbase_ai');
  assert.equal(aiCount,1);assert.equal(a.items[0].source_date,'2026-10-09');
  const b=await advisor(14);assert.equal(b.cached,true);assert.equal(aiCount,1);
  records.push({record_uuid:'r2',tool_type:'emotion',health_date:date,payload_json:'{"answers":{"stress":5}}'});
  const c=await advisor(14);assert.equal(aiCount,2);assert.equal(c.items.length,2);
  date='2026-10-10';const d=await advisor(14);assert.equal(aiCount,3);assert.equal(d.cached,false);
});
test('simultaneous calls claim one generation only',async()=>{
  records.push({record_uuid:'r3',tool_type:'diet',health_date:date,payload_json:'{"answers":{"regularity":"有"}}'});
  const before=aiCount;
  const [a,b,c]=await Promise.all([advisor(14),advisor(14),advisor(14)]);
  assert.equal(aiCount,before+1);
  for(const x of [a,b,c])assert.equal(x.available,true);
});
test('same UUID changed input changes hash',()=>{
  const a={record_uuid:'r1',tool_type:'sleep',payload_json:'{"quality":3}'};
  assert.notEqual(fingerprint([a]),fingerprint([{...a,payload_json:'{"quality":4}'}]));
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ai = require('../src/ai');
const script = fs.readFileSync(path.join(__dirname, '../src/domain.js'), 'utf8');
const day = '2026-10-10';

function makeDate(value=day) {
  return {
    isValid:true, zoneName:'Asia/Shanghai', hour:14, minutes:5,
    setZone(){return this;}, toISODate(){return value;},
    toFormat(){return '2026-10-10 14:00:00';}, toUTC(){return this;},
    startOf(){return this;}, minus(){return this;},
    diff(){return {days:0,minutes:10};}
  };
}
const DateTime = {utc:()=>makeDate(), fromISO:()=>makeDate()};

function makeDomain(initial) {
  const rows = initial.map((r,i)=>({id:i+1, user_id:5,health_date:day,active:1,plan_id:'old-plan',
    core_task_type:'breathing',core_mode_id:'slow_exhale',action_id:'breathing_slow_exhale_60',
    title:'慢呼吸',duration_sec:60,status:'open',...r}));
  const seen=[];
  const db={
    async one(sql) {
      if (sql.includes('FROM healtools_user_routines')) return {timezone:'Asia/Shanghai'};
      if (sql.includes('FROM healtools_task_records')) return null;
      if (sql.includes('SUM(delta)')) return {n:1};
      throw Error('unexpected one: '+sql);
    },
    async query(sql) {
      if (sql.includes('FROM healtools_daily_cards') && sql.includes('active=1'))
        return rows.filter(r=>r.active).sort((a,b)=>a.card_no-b.card_no).map(r=>({...r}));
      throw Error('unexpected query: '+sql);
    },
    async tx(fn) {
      const conn={async execute(sql,args){
        seen.push({sql,args});
        if (sql.includes('ORDER BY card_no DESC LIMIT 1 FOR UPDATE')) return [[{card_no:Math.max(0,...rows.map(r=>r.card_no))}]];
        if (sql.includes('FROM healtools_daily_cards') && sql.includes('card_no=?'))
          return [rows.filter(r=>r.card_no===args[2]).map(r=>({...r}))];
        if (sql.includes('SET active=0')) rows.forEach(r=>{if(r.active)r.active=0;});
        if (sql.includes('INSERT INTO healtools_daily_cards')) {
          rows.push({id:rows.length+1,user_id:args[0],health_date:args[1],card_no:args[2],
            core_task_type:args[3],core_mode_id:args[4],action_id:args[5],title:args[6],duration_sec:args[7],
            plan_id:args[9],active:1,status:'open'});
        }
        if (sql.includes('UPDATE healtools_daily_cards') && sql.includes('SET plan_id=')) {
          const row=rows.find(r=>r.id===args[2]);if(row){row.plan_id=args[0];row.active=1;}
        }
        if (sql.includes('UPDATE healtools_daily_cards') && sql.includes('SET core_task_type=')) {
          const row=rows.find(r=>r.id===args[sql.includes('WHERE id=?')?args.length-1:0]);
          if(row){row.core_task_type=args[0];row.core_mode_id=args[1];row.action_id=args[2];row.plan_id=args[6];row.status='open';}
        }
        if (sql.includes('SET status=\'completed\'')) {
          const row=rows.find(r=>r.id===args[2]);if(row)row.status='completed';
        }
        return [{affectedRows:1}];
      }};
      return fn(conn);
    }
  };
  const module={exports:{}};
  const requireMock=(id)=>{
    if(id==='crypto')return require('node:crypto');
    if(id==='luxon')return {DateTime};
    if(id==='./db')return db;
    if(id==='./ai')return {ACTIONS:ai.ACTIONS,recommend:ai.recommend,generateLifestyleInsight:()=>{}};
    throw Error('unexpected module '+id);
  };
  vm.runInThisContext('(function(require,module,exports){'+script+'\n})')(requireMock,module,module.exports);
  return {domain:module.exports,rows,seen};
}
const newAction={...ai.ACTIONS.meditation_mindful_300,reason:'换个功能'};

test('fully done locally but still open on server starts a new card number',async()=>{
  const m=makeDomain([{card_no:1,status:'open'}]);
  const result=await m.domain.applyPlan(5,[newAction],false,'deterministic_v040',{
    replan:true,client_completed_card_nos:[1]});
  assert.deepEqual(result.map(x=>x.card_no),[2]);
  assert.equal(result[0].core_task_type,'meditation');
  assert.equal(result[0].status,'open');
  assert.equal(m.rows.find(r=>r.card_no===1).active,0);
  assert.equal(m.rows.find(r=>r.card_no===1).status,'open'); // pending sync remains creditable
});

test('partial completion protects locally done number when cloud status lags',async()=>{
  const m=makeDomain([{card_no:1,status:'open'}, {card_no:2,status:'open'}]);
  const result=await m.domain.applyPlan(5,[newAction],false,'deterministic_v040',{
    replan:true,client_completed_card_nos:[1]});
  assert.equal(result.find(x=>x.card_no===1).action_id,'breathing_slow_exhale_60');
  assert.equal(result.find(x=>x.card_no===2).action_id,'meditation_mindful_300');
});

test('cloud recommendations prefer an unused tool and unused action',async()=>{
  const r=await ai.recommend({text:'',quickIntents:['stressed'],excludeActionIds:['breathing_slow_exhale_60'],excludeTools:['breathing']});
  assert.equal(r.actions[0].tool,'meditation');
  assert.notEqual(r.actions[0].action_id,'breathing_slow_exhale_60');
});

test('late sync of archived old card can award it without reactivating the card',async()=>{
  const m=makeDomain([{card_no:1,active:0,status:'open'}]);
  const r=await m.domain.submitRecord(5,'breathing',{
    record_id:'2ed21c84-a254-40d9-8f6c-420e5e65e4f9',health_date:day,
    role:'core',card_no:1,action_id:'breathing_slow_exhale_60',
    mode_id:'slow_exhale',completed_sec:60,planned_sec:60,started_at:'2026-10-10T13:55:00+08:00'
  });
  assert.equal(r.star_delta,1);
  assert.equal(m.rows[0].status,'completed');
  assert.equal(m.rows[0].active,0);
  assert.ok(m.seen.some(x=>x.sql.includes('FROM healtools_daily_cards') && x.sql.includes('card_no=?') && !x.sql.includes('active=1')));
});

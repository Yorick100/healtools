const crypto=require('crypto');
const db=require('./db');
const {healthDate}=require('./domain');
const {generateLifestyleInsight}=require('./ai');
function payload(x){try{return typeof x==='string'?JSON.parse(x):x||{};}catch(_){return {};}}
const TYPES=['sleep','diet','emotion'];
function fallback(type,p){
 if(type==='sleep')return Number(p.quality||0)<=2?'最近一次睡眠感受偏低，可以尝试固定起床时间，睡前留出一段安静的放松时间。':'继续保持适合自己的作息节奏，关注睡醒后的主观感受。';
 if(type==='diet')return p.answers?.regularity==='有'?'可以尝试提前安排下一餐，避免长时间空腹；无需严格计算食物热量。':'尝试保持规律用餐，并按自己的条件兼顾主食、蛋白质和蔬菜。';
 return Number(p.answers?.stress||0)>=4?'你记录的压力较高，可以尝试短暂离开当前任务，做一次舒适慢呼吸。':'留意今天的精力与压力变化，给自己留一点可执行的休息时间。';
}
async function advisor(userId){
 const h=await healthDate(userId), today=h.health_date;
 const rows=await db.query(`SELECT record_uuid,tool_type,health_date,payload_json,COALESCE(completed_at,client_updated_at,client_created_at,started_at) entered_at FROM healtools_task_records WHERE user_id=? AND tool_type IN ('sleep','diet','emotion') AND deleted_at IS NULL AND status IN ('completed','partial','late_record') ORDER BY COALESCE(completed_at,client_updated_at,client_created_at,started_at) DESC,id DESC LIMIT 150`,[userId]);
 const latest={};for(const r of rows){if(!latest[r.tool_type])latest[r.tool_type]=r;}
 const sources=TYPES.filter(x=>latest[x]);const result={title:'AI健康顾问 · 个人生活建议',health_date:today,available:sources.length>0,items:[],based_on_date:'',note:'建议仅基于你输入的日常记录，不是疾病诊断或治疗方案。'};
 if(!sources.length)return {...result,provider:'no_data',cached:true};
 const fingerprint=sources.map(x=>`${x}:${latest[x].record_uuid}`).join('|');
 const hash=crypto.createHash('sha256').update(fingerprint).digest('hex');
 const cached=await db.one('SELECT source_hash,provider,content_json,generated_at FROM healtools_advisor_insights WHERE user_id=? AND insight_date=?',[userId,today]);
 if(cached?.source_hash===hash && cached.provider!=='generating')return {...payload(cached.content_json),provider:cached.provider,cached:true,generated_at:cached.generated_at};
 // Claim generation through an atomic unique-day row. A newly changed hash invalidates the previous result.
 let owns=false;
 if(!cached){
  const x=await db.query(`INSERT IGNORE INTO healtools_advisor_insights(user_id,insight_date,source_hash,provider,content_json,generated_at) VALUES(?,?,?,'generating','{}',UTC_TIMESTAMP())`,[userId,today,hash]);owns=Number(x.affectedRows)>0;
 }else{
  const x=await db.query(`UPDATE healtools_advisor_insights SET source_hash=?,provider='generating',content_json='{}',generated_at=UTC_TIMESTAMP() WHERE user_id=? AND insight_date=? AND source_hash=? AND (provider<>'generating' OR generated_at<UTC_TIMESTAMP()-INTERVAL 30 SECOND)`,[hash,userId,today,cached.source_hash]);owns=Number(x.affectedRows)>0;
 }
 if(!owns){for(let i=0;i<15;i++){await new Promise(r=>setTimeout(r,300));const row=await db.one('SELECT source_hash,provider,content_json,generated_at FROM healtools_advisor_insights WHERE user_id=? AND insight_date=?',[userId,today]);if(row?.source_hash===hash && row.provider!=='generating')return {...payload(row.content_json),provider:row.provider,cached:true,generated_at:row.generated_at};}return {...result,provider:'generating',pending:true};}
 try{
  const ctx={based_on_date:today};
  const info={sleep:'睡眠日记',diet:'饮食计划',emotion:'情绪自评'};
  result.items=sources.map(type=>{const r=latest[type],p=payload(r.payload_json);ctx[type]={available:true,...(type==='sleep'?{quality:p.quality,latency_min:p.sleep_latency_min,awakenings:p.awakenings,bedtime_text:p.bedtime_text,wake_time_text:p.wake_time_text}:type==='diet'?{meal_time_text:p.meal_time_text,regularity:p.answers?.regularity,plate:p.answers?.plate,night:p.answers?.night}:{energy:p.answers?.energy,stress:p.answers?.stress})};return {type,title:info[type],summary:`基于最近一次${info[type]}输入`,source_date:String(r.health_date).slice(0,10),text:fallback(type,p)};});
  let provider='deterministic_v046';
  try{const ai=await generateLifestyleInsight(ctx);if(ai){for(const item of result.items)if(ai[item.type])item.text=ai[item.type];if(ai.overall)result.overall=ai.overall;provider='cloudbase_ai';}}catch(e){console.warn('[advisor]',e.message);}
  const latestHash=(await db.one('SELECT source_hash FROM healtools_advisor_insights WHERE user_id=? AND insight_date=?',[userId,today]))?.source_hash;
  if(latestHash===hash)await db.query(`UPDATE healtools_advisor_insights SET provider=?,content_json=?,generated_at=UTC_TIMESTAMP() WHERE user_id=? AND insight_date=? AND source_hash=?`,[provider,JSON.stringify(result),userId,today,hash]);
  return {...result,provider,cached:false};
 }catch(e){await db.query(`UPDATE healtools_advisor_insights SET provider='error' WHERE user_id=? AND insight_date=? AND source_hash=?`,[userId,today,hash]).catch(()=>{});throw e;}
}
module.exports={advisor};

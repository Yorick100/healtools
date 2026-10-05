const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const db = require('./db');
const domain = require('./domain');
const ai = require('./ai');
const { cloudbaseApp } = require('./cloudbase');
const { basicAuth, dashboard } = require('./admin');

function fail(res, status, code, message, extra={}) { return res.status(status).json({ code, message, data:{ retryable:status>=500 || status===429, ...extra } }); }
function identity(req) {
  let openid = String(req.headers['x-wx-openid'] || '');
  let appid = String(req.headers['x-wx-appid'] || '');
  const unionid = String(req.headers['x-wx-unionid'] || '') || null;
  if (!openid && process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEV_OPENID === '1') { openid=String(req.headers['x-dev-openid'] || 'dev-openid'); appid=appid || 'dev-appid'; }
  return { openid, appid:appid || 'unknown', unionid };
}
async function requireUser(req,res,next) {
  try {
    const id = identity(req); if (!id.openid) return fail(res,401,'wechat_identity_missing','未取得微信身份。请确认小程序通过 wx.cloud.callContainer 调用云托管服务。');
    req.htUser = await domain.ensureUser(id.openid,id.appid,id.unionid); next();
  } catch (e) { next(e); }
}
function readAudioFiles() { try { return JSON.parse(fs.readFileSync(path.join(__dirname,'..','config','audio-files.json'),'utf8')); } catch (_) { return {}; } }

function register(app) {
  app.get('/system/ping', (req,res)=>{ const ready=ai.aiConfigured(); res.json({ok:true,server_time:new Date().toISOString(),service:'healtools-cloudrun',version:'0.4.1',ai_enabled:ready,ai_provider:ready?'cloudbase_http':'deterministic_v040',ai_model:process.env.CLOUDBASE_AI_MODEL||null}); });
  app.get('/content/config', (req,res)=>res.json({
    config_version:4,
    min_app_version:'0.4.0',
    quick_needs:[
      {key:'energize',title:'想提提神'},{key:'annoyed',title:'有点烦'},{key:'stressed',title:'压力有点大'},
      {key:'relax',title:'想放松'},{key:'focus',title:'想专注一下'},{key:'sleep',title:'准备睡觉'}
    ],
    breathing_modes:[{id:'slow_exhale',inhale:4,hold_in:0,exhale:6,hold_out:0,default:true},{id:'box',inhale:4,hold_in:4,exhale:4,hold_out:4},{id:'4_7_8',inhale:4,hold_in:7,exhale:8,hold_out:0}],
    audio_base_url:process.env.HEALTOOLS_AUDIO_BASE_URL || '',
    audio_files:readAudioFiles(),
    system_copy:{non_medical:'本产品用于日常健康自律，不提供诊断、治疗或处方。'}
  }));

  app.post('/auth/wechat', requireUser, async (req,res,next)=>{ try { const u=req.htUser; const p=await domain.profile(u.id); for(const c of (Array.isArray(req.body?.consents)?req.body.consents:[])){ if(c?.type&&c?.version) await db.query(`INSERT IGNORE INTO healtools_consent_records(user_id,consent_type,version,agreed_at) VALUES(?,?,?,UTC_TIMESTAMP())`,[u.id,String(c.type).slice(0,30),String(c.version).slice(0,30)]); } res.json({user_id:u.user_uuid,profile:p,needs_nickname:!p.nickname,auth_mode:'wxcloud_native'}); } catch(e){next(e);} });
  app.post('/auth/logout', requireUser, (req,res)=>res.json({ok:true}));
  app.post('/auth/wechat/bind', requireUser, (req,res)=>res.json({ok:true,wechat_bound:true}));

  app.get('/me', requireUser, async (req,res,next)=>{ try { const u=req.htUser,p=await domain.profile(u.id),r=await domain.routine(u.id);res.json({user_id:u.user_uuid,profile:p,account:{email:null,wechat_bound:true},routine:r,server_time:new Date().toISOString()}); }catch(e){next(e);} });
  app.put('/me/profile', requireUser, async (req,res,next)=>{ try { const nickname=String(req.body?.nickname||'').trim(); if(!nickname || [...nickname].length>20)return fail(res,400,'validation_error','昵称需为 1–20 个字符'); await db.query(`INSERT INTO healtools_user_profiles(user_id,nickname,server_version,updated_at) VALUES(?,?,1,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE nickname=VALUES(nickname),server_version=server_version+1,updated_at=UTC_TIMESTAMP()`,[req.htUser.id,nickname]); res.json({profile:await domain.profile(req.htUser.id)}); }catch(e){next(e);} });
  app.put('/me/routine', requireUser, async (req,res,next)=>{ try { const wake=String(req.body?.usual_wake_time||'07:30').slice(0,5),sleep=String(req.body?.usual_sleep_time||'23:30').slice(0,5),tz=String(req.body?.timezone||'Asia/Shanghai'); if(!DateTime.now().setZone(tz).isValid)return fail(res,400,'validation_error','timezone 必须为有效 IANA 时区'); await db.query(`INSERT INTO healtools_user_routines(user_id,usual_wake_time,usual_sleep_time,timezone,server_version,updated_at) VALUES(?,?,?,?,1,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE usual_wake_time=VALUES(usual_wake_time),usual_sleep_time=VALUES(usual_sleep_time),timezone=VALUES(timezone),server_version=server_version+1,updated_at=UTC_TIMESTAMP()`,[req.htUser.id,wake,sleep,tz]); res.json({routine:await domain.routine(req.htUser.id),effective_from:'next_health_day'}); }catch(e){next(e);} });

  app.get('/today', requireUser, async (req,res,next)=>{ try { const u=req.htUser,h=await domain.healthDate(u.id),rows=await domain.ensurePlan(u.id),sum=await domain.starSummary(u.id);res.json({server_time:new Date().toISOString(),health_date:h.health_date,timezone:h.timezone,plan_id:rows[0]?.plan_id||'',...sum,morning_review:{needed:true,sleep_date:DateTime.fromISO(h.health_date).minus({days:1}).toISODate()},cards:domain.apiCards(rows),config_version:4}); }catch(e){next(e);} });
  app.post('/ai/recommend', requireUser, async (req,res,next)=>{ try { const u=req.htUser,text=String(req.body?.text||'').trim().slice(0,200),quick=Array.isArray(req.body?.quick_intents)?req.body.quick_intents.slice(0,6):[]; if(ai.hitsSafetyBoundary(text)){await domain.usageEvent(u.id,'ai_safety_boundary',{health_date:(await domain.healthDate(u.id)).health_date});return fail(res,422,'ai_safety_boundary','这类情况不适合用日常行动卡处理；如存在紧急或严重不适，请尽快寻求专业医疗帮助。');} const h=await domain.healthDate(u.id);await domain.usageEvent(u.id,'ai_prompt_submit',{health_date:h.health_date,quick_count:quick.length,has_text:text?1:0});const rec=await ai.recommend({quickIntents:quick,text,light:!!req.body?.light_day,maxCards:Number(req.body?.max_cards||3),localHour:h.localHour});const rows=await domain.applyPlan(u.id,rec.actions,!!req.body?.light_day,rec.provider,{quick_intents:rec.intents});await domain.usageEvent(u.id,'ai_recommend_success',{health_date:h.health_date,card_count:rows.length,fallback:rec.fallback?1:0,provider:rec.provider});res.json({plan_id:rows[0]?.plan_id||'',cards:domain.apiCards(rows),fallback:rec.fallback,provider:rec.provider,...(await domain.starSummary(u.id)),server_time:new Date().toISOString()}); }catch(e){next(e);} });

  for (const tool of ['breathing','meditation']) app.post(`/${tool}/sessions`,requireUser,async(req,res,next)=>{try{res.json(await domain.submitRecord(req.htUser.id,tool,req.body||{}));}catch(e){next(e);}});
  app.post('/diet/checkins',requireUser,async(req,res,next)=>{try{res.json(await domain.submitRecord(req.htUser.id,'diet',req.body||{}));}catch(e){next(e);}});
  app.post('/emotion/assessments',requireUser,async(req,res,next)=>{try{res.json(await domain.submitRecord(req.htUser.id,'emotion',req.body||{}));}catch(e){next(e);}});
  app.post('/sleep/diaries',requireUser,async(req,res,next)=>{try{res.json(await domain.submitRecord(req.htUser.id,'sleep',req.body||{}));}catch(e){next(e);}});

  app.get('/history',requireUser,async(req,res,next)=>{try{const from=String(req.query.from||DateTime.utc().minus({days:29}).toISODate()),to=String(req.query.to||DateTime.utc().toISODate()),uid=req.htUser.id;const stars=await db.query(`SELECT health_date,card_no,created_at FROM healtools_star_ledger WHERE user_id=? AND health_date BETWEEN ? AND ? ORDER BY health_date DESC,card_no`,[uid,from,to]);const records=await db.query(`SELECT record_uuid,health_date,card_no,tool_type,role,status,completed_at,server_version FROM healtools_task_records WHERE user_id=? AND health_date BETWEEN ? AND ? AND deleted_at IS NULL ORDER BY health_date DESC LIMIT 200`,[uid,from,to]);const plans=await db.query(`SELECT health_date,COUNT(*) planned_count,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed_count FROM healtools_daily_cards WHERE user_id=? AND health_date BETWEEN ? AND ? AND active=1 GROUP BY health_date ORDER BY health_date DESC`,[uid,from,to]);res.json({from,to,stars,records,plans,server_time:new Date().toISOString()});}catch(e){next(e);}});
  app.get('/weekly-insight',requireUser,async(req,res,next)=>{try{const s=await domain.starSummary(req.htUser.id);res.json({week_start:DateTime.utc().startOf('week').toISODate(),insight:{code:'weekly_consistency',text:`本周已记录 ${s.week_star} 颗星。这只是行为记录，不代表医学健康水平。`,non_causal:true}});}catch(e){next(e);}});

  const resourceTool={breathing_session:'breathing',meditation_session:'meditation',diet_checkin:'diet',emotion_assessment:'emotion',sleep_diary:'sleep'};
  app.post('/sync/batch',requireUser,async(req,res,next)=>{try{const rows=Array.isArray(req.body?.mutations)?req.body.mutations.slice(0,100):[],results=[];for(const m of rows){const tool=resourceTool[String(m.resource||'')];if(!tool){results.push({mutation_id:m.mutation_id,status:'ignored'});continue;}try{const p={...(m.payload||{}),record_id:m.record_id||m.mutation_id,health_date:m.health_date||(m.payload||{}).health_date,role:m.role||(m.payload||{}).role,card_no:m.card_no||(m.payload||{}).card_no};const r=await domain.submitRecord(req.htUser.id,tool,p);results.push({mutation_id:m.mutation_id,status:r.duplicate?'duplicate':'applied',server_version:r.server_version});}catch(e){results.push({mutation_id:m.mutation_id,status:'error',code:e.code||'service_error'});}}const cur=await db.one(`SELECT COALESCE(MAX(change_id),0) n FROM healtools_sync_changes WHERE user_id=?`,[req.htUser.id]);res.json({results,changes:[],next_cursor:Number(cur.n||0),summary:await domain.starSummary(req.htUser.id),server_time:new Date().toISOString()});}catch(e){next(e);}});
  app.post('/guest/merge',requireUser,async(req,res,next)=>{try{const rows=Array.isArray(req.body?.records)?req.body.records.slice(0,100):[];let merged=0,skipped=0,star_delta=0;for(const m of rows){const tool=resourceTool[String(m.resource||'')];if(!tool){skipped++;continue;}try{const r=await domain.submitRecord(req.htUser.id,tool,{...(m.payload||{}),record_id:m.record_id||(m.payload||{}).record_id});if(r.duplicate)skipped++;else merged++;star_delta+=Number(r.star_delta||0);}catch(_){skipped++;}}res.json({merged_records:merged,skipped_records:skipped,star_delta,...(await domain.starSummary(req.htUser.id))});}catch(e){next(e);}});

  app.post('/data-export',requireUser,async(req,res,next)=>{try{const uid=req.htUser.id,u=req.htUser;const data={exported_at:new Date().toISOString(),user_id:u.user_uuid,profile:await domain.profile(uid),routine:await domain.routine(uid),daily_cards:await db.query(`SELECT * FROM healtools_daily_cards WHERE user_id=? ORDER BY health_date,card_no`,[uid]),records:await db.query(`SELECT * FROM healtools_task_records WHERE user_id=? AND deleted_at IS NULL ORDER BY health_date`,[uid]),stars:await db.query(`SELECT * FROM healtools_star_ledger WHERE user_id=? ORDER BY created_at`,[uid])};const cb=cloudbaseApp();if(!cb)return res.json({storage:false,data});const file=Buffer.from(JSON.stringify(data,null,2),'utf8'),cloudPath=`healtools/private/exports/${u.user_uuid}/${domain.uuid()}.json`;const up=await cb.uploadFile({cloudPath,fileContent:file});let url='';try{const x=await cb.getTempFileURL({fileList:[up.fileID]});url=x?.fileList?.[0]?.tempFileURL||'';}catch(_){}res.json({storage:true,file_id:up.fileID,download_url:url,expires_notice:'临时链接会过期，请及时下载。'});}catch(e){next(e);}});
  app.delete('/me/data',requireUser,async(req,res,next)=>{try{if(String(req.body?.confirm||'')!=='DELETE')return fail(res,400,'confirmation_required','请提交 confirm=DELETE 以确认删除。');const uid=req.htUser.id;await db.tx(async conn=>{for(const t of ['healtools_consent_records','healtools_daily_cards','healtools_task_records','healtools_star_ledger','healtools_sync_changes','healtools_usage_events','healtools_user_profiles','healtools_user_routines','healtools_wechat_identities'])await conn.execute(`DELETE FROM ${t} WHERE user_id=?`,[uid]);await conn.execute(`DELETE FROM healtools_users WHERE id=?`,[uid]);});res.json({deleted:true,server_time:new Date().toISOString()});}catch(e){next(e);}});

  app.get('/admin',basicAuth,dashboard);
}
module.exports = { register, requireUser, fail };

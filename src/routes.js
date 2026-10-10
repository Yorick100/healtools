const { DateTime } = require('luxon');
const db = require('./db');
const domain = require('./domain');
const ai = require('./ai');
const { cloudbaseApp } = require('./cloudbase');
const { basicAuth, dashboard } = require('./admin');
const {advisor}=require('./advisor');

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
    req.htUser = await domain.ensureUser(id.openid,id.appid,id.unionid);
    const tz = String(req.headers['x-healtools-timezone'] || '').trim();
    if (tz && DateTime.now().setZone(tz).isValid) await domain.syncTimezone(req.htUser.id, tz);
    // Best-effort unique daily heartbeat; this should never block user requests.
    const day=(await domain.healthDate(req.htUser.id)).health_date;
    await db.query(`INSERT INTO healtools_user_daily_activity(user_id,activity_date,first_active_at,last_active_at,request_count) VALUES(?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP(),1) ON DUPLICATE KEY UPDATE last_active_at=UTC_TIMESTAMP(),request_count=request_count+1`,[req.htUser.id,day]).catch(e=>console.warn('[activity]',e.message));
    next();
  } catch (e) { next(e); }
}
async function responseWithAdvice(userId, tool, out) {
  if (!['sleep','diet','emotion'].includes(tool)) return out;
  try { return { ...out, advisor_insight:await advisor(userId) }; }
  catch (err) { console.warn('[advisor] generation after save failed:',String(err.message||err).slice(0,180)); return { ...out, advisor_error:'建议生成暂时失败，可到记录页重试' }; }
}
function register(app) {
  app.get('/system/ping', (req,res)=>{ res.set('X-HEALTOOLS-Backend', '0.5.0'); const ready=ai.aiConfigured(); res.json({ok:true,server_time:new Date().toISOString(),service:'healtools-cloudrun',version:'0.5.0',ai_enabled:ready,ai_provider:ready?'cloudbase_http':'deterministic_v040',ai_model:process.env.CLOUDBASE_AI_MODEL||null}); });
  // This is a database readiness check; /system/ping only checks the HTTP process.
  app.get('/system/ready', async (req,res)=>{
    let timer;
    try { await Promise.race([db.one('SELECT 1 AS healthy'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('DB timeout')),3000);})]);
      res.json({ok:true,backend_version:'0.5.0',database:'reachable'});
    } catch (e) { console.error('[ready] database not reachable:',String(e.message||e).slice(0,180));
      res.status(503).json({ok:false,backend_version:'0.5.0',database:'unavailable',request_id:req.requestId}); }
    finally { if(timer)clearTimeout(timer); }
  });
  app.get('/content/config', (req,res)=>res.json({
    config_version:7,
    min_app_version:'0.4.0',
    quick_needs:[
      {key:'energize',title:'想提提神'},{key:'annoyed',title:'有点烦'},{key:'stressed',title:'压力有点大'},
      {key:'relax',title:'想放松'},{key:'focus',title:'想专注一下'},{key:'sleep',title:'准备睡觉'}
    ],
    breathing_modes:[{id:'slow_exhale',inhale:4,hold_in:0,exhale:6,hold_out:0,default:true},{id:'box',inhale:4,hold_in:4,exhale:4,hold_out:4},{id:'4_7_8',inhale:4,hold_in:7,exhale:8,hold_out:0}],
    audio_base_url:process.env.HEALTOOLS_AUDIO_BASE_URL || '',
    audio_files:{},
    system_copy:{non_medical:'本产品用于日常健康自律，不提供诊断、治疗或处方。'}
  }));

  app.post('/auth/wechat', requireUser, async (req,res,next)=>{ try { const u=req.htUser; const p=await domain.profile(u.id); for(const c of (Array.isArray(req.body?.consents)?req.body.consents:[])){ if(c?.type&&c?.version) await db.query(`INSERT IGNORE INTO healtools_consent_records(user_id,consent_type,version,agreed_at) VALUES(?,?,?,UTC_TIMESTAMP())`,[u.id,String(c.type).slice(0,30),String(c.version).slice(0,30)]); } res.json({user_id:u.user_uuid,profile:p,needs_nickname:!p.nickname,auth_mode:'wxcloud_native'}); } catch(e){next(e);} });
  app.post('/auth/logout', requireUser, (req,res)=>res.json({ok:true}));
  app.post('/auth/wechat/bind', requireUser, (req,res)=>res.json({ok:true,wechat_bound:true}));

  app.get('/me', requireUser, async (req,res,next)=>{ try { const u=req.htUser,p=await domain.profile(u.id),r=await domain.routine(u.id);res.json({user_id:u.user_uuid,profile:p,account:{email:null,wechat_bound:true},routine:r,server_time:new Date().toISOString()}); }catch(e){next(e);} });
  app.put('/me/profile', requireUser, async (req,res,next)=>{ try { const nickname=String(req.body?.nickname||'').trim(); if(!nickname || [...nickname].length>20)return fail(res,400,'validation_error','昵称需为 1–20 个字符'); await db.query(`INSERT INTO healtools_user_profiles(user_id,nickname,server_version,updated_at) VALUES(?,?,1,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE nickname=VALUES(nickname),server_version=server_version+1,updated_at=UTC_TIMESTAMP()`,[req.htUser.id,nickname]); res.json({profile:await domain.profile(req.htUser.id)}); }catch(e){next(e);} });
  app.put('/me/routine', requireUser, async (req,res,next)=>{ try { const wake=String(req.body?.usual_wake_time||'07:30').slice(0,5),sleep=String(req.body?.usual_sleep_time||'23:30').slice(0,5),tz=String(req.body?.timezone||'Asia/Shanghai'); if(!DateTime.now().setZone(tz).isValid)return fail(res,400,'validation_error','timezone 必须为有效 IANA 时区'); await db.query(`INSERT INTO healtools_user_routines(user_id,usual_wake_time,usual_sleep_time,timezone,server_version,updated_at) VALUES(?,?,?,?,1,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE usual_wake_time=VALUES(usual_wake_time),usual_sleep_time=VALUES(usual_sleep_time),timezone=VALUES(timezone),server_version=server_version+1,updated_at=UTC_TIMESTAMP()`,[req.htUser.id,wake,sleep,tz]); res.json({routine:await domain.routine(req.htUser.id),effective_from:'immediate'}); }catch(e){next(e);} });

  app.get('/today', requireUser, async (req,res,next)=>{ try { const u=req.htUser,h=await domain.healthDate(u.id),rows=await domain.ensurePlan(u.id),sum=await domain.starSummary(u.id),history=await domain.recentHealthContext(u.id);res.json({server_time:new Date().toISOString(),health_date:h.health_date,timezone:h.timezone,plan_id:rows[0]?.plan_id||'',...sum,morning_review:{needed:!history.sleep?.available,sleep_date:history.yesterday},cards:domain.apiCards(rows),config_version:7}); }catch(e){next(e);} });
  app.post('/ai/recommend', requireUser, async (req,res,next)=>{
    try {
      const u=req.htUser;
      const text=String(req.body?.text||'').trim().slice(0,200);
      const quick=Array.isArray(req.body?.quick_intents)?req.body.quick_intents.slice(0,6):[];
      const replan=!!req.body?.replan;
      if(ai.hitsSafetyBoundary(text)){
        await domain.usageEvent(u.id,'ai_safety_boundary',{health_date:(await domain.healthDate(u.id)).health_date});
        return fail(res,422,'ai_safety_boundary','这类情况不适合用日常行动卡处理；如存在紧急或严重不适，请尽快寻求专业医疗帮助。');
      }
      const h=await domain.healthDate(u.id);
      const existing=await domain.currentCards(u.id,h.health_date);
      const completedCount=existing.filter(x=>x.status==='completed').length;
      const remainingNeeded=replan && completedCount>0 && completedCount<existing.length ? existing.length-completedCount : 0;
      const excludeActionIds=replan ? existing.map(x=>String(x.action_id||'')).filter(Boolean) : [];
      await domain.usageEvent(u.id,'ai_prompt_submit',{health_date:h.health_date,quick_count:quick.length,has_text:text?1:0,replan:replan?1:0});
      const history=await domain.recentHealthContext(u.id);
      const rec=await ai.recommend({
        quickIntents:quick,
        text,
        light:!!req.body?.light_day,
        maxCards:Number(req.body?.max_cards||3),
        minCards:remainingNeeded,
        localHour:h.localHour,
        history,
        excludeActionIds
      });
      const rows=await domain.applyPlan(u.id,rec.actions,!!req.body?.light_day,rec.provider,{
        quick_intents:rec.intents,
        history_used:rec.history_used?1:0,
        replan
      });
      await domain.usageEvent(u.id,'ai_recommend_success',{
        health_date:h.health_date,
        card_count:rows.length,
        fallback:rec.fallback?1:0,
        provider:rec.provider,
        history_used:rec.history_used?1:0,
        replan:replan?1:0
      });
      res.json({
        plan_id:rows[0]?.plan_id||'',
        cards:domain.apiCards(rows),
        fallback:rec.fallback,
        provider:rec.provider,
        history_used:!!rec.history_used,
        replan,
        ...(await domain.starSummary(u.id)),
        server_time:new Date().toISOString()
      });
    }catch(e){next(e);}
  });

  for (const tool of ['breathing','meditation']) app.post(`/${tool}/sessions`,requireUser,async(req,res,next)=>{try{const out=await domain.submitRecord(req.htUser.id,tool,req.body||{});console.info('[record] saved',JSON.stringify({tool,duplicate:!!out.duplicate,request_id:req.requestId}));res.json(out);}catch(e){next(e);}});
  app.post('/diet/checkins',requireUser,async(req,res,next)=>{try{const out=await domain.submitRecord(req.htUser.id,'diet',req.body||{});console.info('[record] saved',JSON.stringify({tool:'diet',duplicate:!!out.duplicate,request_id:req.requestId}));res.json(await responseWithAdvice(req.htUser.id,'diet',out));}catch(e){next(e);}});
  app.post('/emotion/assessments',requireUser,async(req,res,next)=>{try{const out=await domain.submitRecord(req.htUser.id,'emotion',req.body||{});console.info('[record] saved',JSON.stringify({tool:'emotion',duplicate:!!out.duplicate,request_id:req.requestId}));res.json(await responseWithAdvice(req.htUser.id,'emotion',out));}catch(e){next(e);}});
  app.post('/sleep/diaries',requireUser,async(req,res,next)=>{try{const out=await domain.submitRecord(req.htUser.id,'sleep',req.body||{});console.info('[record] saved',JSON.stringify({tool:'sleep',duplicate:!!out.duplicate,request_id:req.requestId}));res.json(await responseWithAdvice(req.htUser.id,'sleep',out));}catch(e){next(e);}});

  // Read-only acknowledgement scoped to the authenticated WeChat identity.
  // No health payload and no other user's UUID can be exposed.
  app.post('/records/confirm',requireUser,async(req,res,next)=>{try{
    const raw=Array.isArray(req.body?.record_ids)?req.body.record_ids:[];
    if(raw.length>100)return fail(res,400,'too_many_records','一次最多核验 100 条记录');
    const ids=[...new Set(raw.map(x=>String(x||'')).filter(x=>/^[a-f0-9-]{36}$/i.test(x)))];
    if(!ids.length)return res.json({records:[]});
    const placeholders=ids.map(()=>'?').join(',');
    const rows=await db.query(`SELECT record_uuid,tool_type FROM healtools_task_records WHERE user_id=? AND deleted_at IS NULL AND record_uuid IN (${placeholders})`,[req.htUser.id,...ids]);
    const found=new Map(rows.map(x=>[String(x.record_uuid),String(x.tool_type)]));
    res.json({records:ids.map(id=>({record_id:id,exists:found.has(id),tool:found.get(id)||null}))});
  }catch(e){next(e);}});

  app.get('/history',requireUser,async(req,res,next)=>{try{
    const from=String(req.query.from||DateTime.utc().minus({days:29}).toISODate()),to=String(req.query.to||DateTime.utc().toISODate()),uid=req.htUser.id;
    const stars=await db.query(`SELECT DATE_FORMAT(health_date,'%Y-%m-%d') health_date,card_no,delta,reason,source_record_uuid,created_at FROM healtools_star_ledger WHERE user_id=? AND health_date BETWEEN ? AND ? ORDER BY health_date DESC,created_at DESC,id DESC`,[uid,from,to]);
    const records=await db.query(`SELECT record_uuid,DATE_FORMAT(health_date,'%Y-%m-%d') health_date,card_no,tool_type,role,status,started_at,completed_at,client_created_at,client_updated_at,payload_json,server_version FROM healtools_task_records WHERE user_id=? AND health_date BETWEEN ? AND ? AND deleted_at IS NULL ORDER BY health_date DESC,COALESCE(completed_at,client_updated_at,client_created_at,started_at) DESC,id DESC LIMIT 500`,[uid,from,to]);
    const plans=await db.query(`SELECT DATE_FORMAT(health_date,'%Y-%m-%d') health_date,COUNT(*) planned_count,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed_count FROM healtools_daily_cards WHERE user_id=? AND health_date BETWEEN ? AND ? AND (active=1 OR status='completed') GROUP BY health_date ORDER BY health_date DESC`,[uid,from,to]);
    const tool_stats=await db.query(`SELECT tool_type,COUNT(*) total_count,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed_count FROM healtools_task_records WHERE user_id=? AND health_date BETWEEN ? AND ? AND deleted_at IS NULL GROUP BY tool_type`,[uid,from,to]);
    res.json({from,to,stars,records,plans,tool_stats,server_time:new Date().toISOString()});
  }catch(e){next(e);}});
  app.get('/daily-insight',requireUser,async(req,res,next)=>{try{res.json(await advisor(req.htUser.id));}catch(e){next(e);}});
  app.get('/weekly-insight',requireUser,async(req,res,next)=>{try{const s=await domain.starSummary(req.htUser.id);res.json({week_start:DateTime.utc().startOf('week').toISODate(),insight:{code:'weekly_consistency',text:`本周已记录 ${s.week_star} 颗星。这只是行为记录，不代表医学健康水平。`,non_causal:true}});}catch(e){next(e);}});

  const resourceTool={breathing_session:'breathing',meditation_session:'meditation',diet_checkin:'diet',emotion_assessment:'emotion',sleep_diary:'sleep'};
  app.post('/sync/batch',requireUser,async(req,res,next)=>{
    try {
      const mutations=Array.isArray(req.body?.mutations)?req.body.mutations.slice(0,100):[];
      const results=[];
      let advisorDirty=false;
      for(const m of mutations){
        const tool=resourceTool[String(m.resource||'')];
        if(!tool){results.push({mutation_id:m.mutation_id,status:'ignored'});continue;}
        try {
          const p={...(m.payload||{}),record_id:m.record_id||m.mutation_id,
            health_date:m.health_date||(m.payload||{}).health_date,role:m.role||(m.payload||{}).role,
            card_no:m.card_no||(m.payload||{}).card_no};
          const r=await domain.submitRecord(req.htUser.id,tool,p);
          results.push({mutation_id:m.mutation_id,status:r.duplicate?'duplicate':'applied',server_version:r.server_version});
          if(['sleep','diet','emotion'].includes(tool))advisorDirty=true;
        } catch (err) {
          console.warn('[sync/batch] mutation failed',JSON.stringify({tool,code:err.code||'service_error',request_id:req.requestId}));
          results.push({mutation_id:m.mutation_id,status:'error',code:err.code||'service_error'});
        }
      }
      if(mutations.length)console.info('[sync/batch] result',JSON.stringify({submitted:mutations.length,applied:results.filter(r=>r.status==='applied').length,duplicate:results.filter(r=>r.status==='duplicate').length,errors:results.filter(r=>r.status==='error').length,ignored:results.filter(r=>r.status==='ignored').length,tools:mutations.map(x=>resourceTool[String(x.resource||'')]||'unknown').reduce((a,t)=>(a[t]=(a[t]||0)+1,a),{}),request_id:req.requestId}));
      const cur=await db.one('SELECT COALESCE(MAX(change_id),0) n FROM healtools_sync_changes WHERE user_id=?',[req.htUser.id]);
      const body={results,changes:[],next_cursor:Number(cur.n||0),summary:await domain.starSummary(req.htUser.id),server_time:new Date().toISOString()};
      // One inference at most per successful batch, after the DB transaction commits.
      // Never let a model outage lose a successfully synchronized health record.
      if(advisorDirty){
        try { body.advisor_insight=await advisor(req.htUser.id); }
        catch(err) { body.advisor_error='建议暂不可用，请稍后进入记录重试'; console.warn('[advisor] batch failed:',String(err.message||err).slice(0,180)); }
      }
      res.json(body);
    } catch(err){next(err);}
  });
  app.post('/guest/merge',requireUser,async(req,res,next)=>{try{const rows=Array.isArray(req.body?.records)?req.body.records.slice(0,100):[];let merged=0,skipped=0,star_delta=0;for(const m of rows){const tool=resourceTool[String(m.resource||'')];if(!tool){skipped++;continue;}try{const r=await domain.submitRecord(req.htUser.id,tool,{...(m.payload||{}),record_id:m.record_id||(m.payload||{}).record_id});if(r.duplicate)skipped++;else merged++;star_delta+=Number(r.star_delta||0);}catch(_){skipped++;}}const response={merged_records:merged,skipped_records:skipped,star_delta,...(await domain.starSummary(req.htUser.id))};
    if(merged>0) { try { response.advisor_insight=await advisor(req.htUser.id); }catch(e){console.warn('[advisor] guest merge',e.message);} }
    res.json(response);}catch(e){next(e);}});

  app.post('/data-export',requireUser,async(req,res,next)=>{try{const uid=req.htUser.id,u=req.htUser;const data={exported_at:new Date().toISOString(),user_id:u.user_uuid,profile:await domain.profile(uid),routine:await domain.routine(uid),daily_cards:await db.query(`SELECT * FROM healtools_daily_cards WHERE user_id=? ORDER BY health_date,card_no`,[uid]),records:await db.query(`SELECT * FROM healtools_task_records WHERE user_id=? AND deleted_at IS NULL ORDER BY health_date`,[uid]),stars:await db.query(`SELECT * FROM healtools_star_ledger WHERE user_id=? ORDER BY created_at`,[uid]),daily_insights:await db.query(`SELECT * FROM healtools_daily_insights WHERE user_id=? ORDER BY insight_date`,[uid])};const cb=cloudbaseApp();if(!cb)return res.json({storage:false,data});const file=Buffer.from(JSON.stringify(data,null,2),'utf8'),cloudPath=`healtools/private/exports/${u.user_uuid}/${domain.uuid()}.json`;const up=await cb.uploadFile({cloudPath,fileContent:file});let url='';try{const x=await cb.getTempFileURL({fileList:[up.fileID]});url=x?.fileList?.[0]?.tempFileURL||'';}catch(_){}res.json({storage:true,file_id:up.fileID,download_url:url,expires_notice:'临时链接会过期，请及时下载。'});}catch(e){next(e);}});
  app.delete('/me/data',requireUser,async(req,res,next)=>{try{if(String(req.body?.confirm||'')!=='DELETE')return fail(res,400,'confirmation_required','请提交 confirm=DELETE 以确认删除。');const uid=req.htUser.id;await db.tx(async conn=>{for(const t of ['healtools_consent_records','healtools_daily_cards','healtools_task_records','healtools_star_ledger','healtools_sync_changes','healtools_usage_events','healtools_daily_insights','healtools_advisor_insights','healtools_user_daily_activity','healtools_user_profiles','healtools_user_routines','healtools_wechat_identities'])await conn.execute(`DELETE FROM ${t} WHERE user_id=?`,[uid]);await conn.execute(`DELETE FROM healtools_users WHERE id=?`,[uid]);});res.json({deleted:true,server_time:new Date().toISOString()});}catch(e){next(e);}});

  app.get('/admin/diagnostics',basicAuth,async(req,res)=>{
    try { await db.one('SELECT 1 AS ok');res.json({ok:true,backend:'0.5.0',database:'reachable'}); }
    catch(err){console.error('[admin/diagnostics]',err.message);res.status(503).json({ok:false,backend:'0.5.0',database:'unavailable',request_id:req.requestId});}
  });
  app.get('/admin',basicAuth,dashboard);
}
module.exports = { register, requireUser, fail };

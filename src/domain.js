const crypto = require('crypto');
const { DateTime } = require('luxon');
const db = require('./db');
const { ACTIONS, recommend } = require('./ai');

const uuid = () => crypto.randomUUID();
const nowSql = () => DateTime.utc().toFormat('yyyy-LL-dd HH:mm:ss');

async function ensureUser(openid, appid='unknown', unionid=null) {
  let row = await db.one(`SELECT u.* FROM healtools_users u JOIN healtools_wechat_identities w ON w.user_id=u.id WHERE w.appid=? AND w.openid=? LIMIT 1`, [appid, openid]);
  const now = nowSql();
  if (!row) {
    await db.tx(async conn => {
      const id = uuid();
      const [u] = await conn.execute(`INSERT INTO healtools_users(user_uuid,status,created_at,updated_at,last_login_at,last_active_at) VALUES(?, 'active', ?, ?, ?, ?)`, [id, now, now, now, now]);
      await conn.execute(`INSERT INTO healtools_wechat_identities(user_id,appid,openid,unionid,created_at,updated_at,last_login_at) VALUES(?,?,?,?,?,?,?)`, [u.insertId, appid, openid, unionid, now, now, now]);
      await conn.execute(`INSERT INTO healtools_user_profiles(user_id,nickname,server_version,updated_at) VALUES(?,NULL,1,?)`, [u.insertId, now]);
      await conn.execute(`INSERT INTO healtools_user_routines(user_id,usual_wake_time,usual_sleep_time,timezone,server_version,updated_at) VALUES(?,'07:30:00','23:30:00','Asia/Shanghai',1,?)`, [u.insertId, now]);
    });
    row = await db.one(`SELECT u.* FROM healtools_users u JOIN healtools_wechat_identities w ON w.user_id=u.id WHERE w.appid=? AND w.openid=? LIMIT 1`, [appid, openid]);
  } else {
    await db.query(`UPDATE healtools_users SET last_login_at=?,last_active_at=?,updated_at=? WHERE id=?`, [now, now, now, row.id]);
    await db.query(`UPDATE healtools_wechat_identities SET unionid=COALESCE(?,unionid),updated_at=?,last_login_at=? WHERE appid=? AND openid=?`, [unionid, now, now, appid, openid]);
  }
  return row;
}

async function profile(userId) { return await db.one(`SELECT nickname,server_version FROM healtools_user_profiles WHERE user_id=?`, [userId]) || { nickname:null, server_version:1 }; }
async function routine(userId) { return await db.one(`SELECT usual_wake_time,usual_sleep_time,timezone,server_version FROM healtools_user_routines WHERE user_id=?`, [userId]) || { usual_wake_time:'07:30:00', usual_sleep_time:'23:30:00', timezone:'Asia/Shanghai', server_version:1 }; }

async function healthDate(userId, now=DateTime.utc()) {
  const r = await routine(userId);
  const zone = r.timezone || 'Asia/Shanghai';
  let local = now.setZone(zone); if (!local.isValid) local = now.setZone('Asia/Shanghai');
  const sleep = String(r.usual_sleep_time || '23:30').slice(0,5).split(':').map(Number);
  const boundary = local.startOf('day').set({ hour:sleep[0] || 23, minute:sleep[1] || 30 }).plus({ minutes:120 });
  const date = local < boundary ? local.minus({ days:1 }).toISODate() : local.toISODate();
  return { health_date:date, timezone:local.zoneName, localHour:local.hour };
}

async function starSummary(userId) {
  const h = await healthDate(userId); const hd = h.health_date;
  const weekStart = DateTime.fromISO(hd).startOf('week').toISODate();
  const today = await db.one(`SELECT COALESCE(SUM(delta),0) n FROM healtools_star_ledger WHERE user_id=? AND health_date=?`, [userId, hd]);
  const week = await db.one(`SELECT COALESCE(SUM(delta),0) n FROM healtools_star_ledger WHERE user_id=? AND health_date>=?`, [userId, weekStart]);
  const total = await db.one(`SELECT COALESCE(SUM(delta),0) n FROM healtools_star_ledger WHERE user_id=?`, [userId]);
  return { today_star:Number(today.n || 0), week_star:Number(week.n || 0), total_star:Number(total.n || 0) };
}

function apiCards(rows) {
  return rows.map(r => {
    const base = ACTIONS[r.action_id] || Object.values(ACTIONS).find(a => a.tool === r.core_task_type && a.mode === r.core_mode_id) || {};
    return { card_no:Number(r.card_no), action_id:r.action_id || base.action_id || '', title:r.title || base.title || '今天的一件小事', desc:base.desc || '', reason:r.reason_text || '根据当前状态与时间，为你安排一个低门槛行动。', tool:r.core_task_type, mode:r.core_mode_id, duration_sec:Number(r.duration_sec || base.duration_sec || 0), status:r.status, light_mode:!!r.light_mode, source:r.source || 'default', hint_time:null };
  });
}

async function currentCards(userId, hd) { return db.query(`SELECT * FROM healtools_daily_cards WHERE user_id=? AND health_date=? AND active=1 ORDER BY card_no`, [userId, hd]); }

async function applyPlan(userId, actions, light, source, context={}) {
  const h = await healthDate(userId); const hd = h.health_date; const existing = await currentCards(userId, hd); const completed = existing.filter(x => x.status === 'completed');
  if (existing.length && completed.length === existing.length) return existing;
  let target = Math.max(1, Math.min(3, actions.length || 1)); if (completed.length) target = existing.length;
  const planId = uuid(), now = nowSql(); let next = 0;
  await db.tx(async conn => {
    for (let no=1; no<=target; no++) {
      const old = existing.find(x => Number(x.card_no) === no);
      if (old && old.status === 'completed') { await conn.execute(`UPDATE healtools_daily_cards SET plan_id=?,active=1,updated_at=? WHERE id=?`, [planId, now, old.id]); continue; }
      const a = actions[next++] || actions[0]; if (!a) continue;
      const snapshot = JSON.stringify({ quick_intents:context.quick_intents || [], light_day:!!light, timezone:h.timezone });
      if (old) await conn.execute(`UPDATE healtools_daily_cards SET core_task_type=?,core_mode_id=?,action_id=?,title=?,duration_sec=?,reason_text=?,plan_id=?,source=?,active=1,light_mode=?,schedule_snapshot_json=?,status='open',completed_at=NULL,star_awarded=0,server_version=server_version+1,updated_at=? WHERE id=?`, [a.tool,a.mode,a.action_id,a.title,a.duration_sec,a.reason || '',planId,source,light?1:0,snapshot,now,old.id]);
      else await conn.execute(`INSERT INTO healtools_daily_cards(user_id,health_date,card_no,core_task_type,core_mode_id,action_id,title,duration_sec,reason_text,plan_id,source,active,light_mode,schedule_snapshot_json,status,star_awarded,server_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?, 'open',0,1,?,?)`, [userId,hd,no,a.tool,a.mode,a.action_id,a.title,a.duration_sec,a.reason || '',planId,source,light?1:0,snapshot,now,now]);
    }
    if (!completed.length) await conn.execute(`UPDATE healtools_daily_cards SET active=0,updated_at=? WHERE user_id=? AND health_date=? AND card_no>? AND status<>'completed'`, [now,userId,hd,target]);
  });
  return currentCards(userId, hd);
}

async function ensurePlan(userId) {
  const h = await healthDate(userId); const rows = await currentCards(userId, h.health_date); if (rows.length) return rows;
  const r = await recommend({ quickIntents:[], text:'', light:false, maxCards:1, localHour:h.localHour }); return applyPlan(userId, r.actions, false, 'default_v040', {});
}

function completed(tool, p) {
  if (tool === 'breathing') return Number(p.completed_sec || 0) >= 0.8 * Math.max(1, Number(p.planned_sec || 1));
  if (tool === 'meditation') return Number(p.played_sec || 0) >= 0.8 * Math.max(1, Number(p.planned_sec || 1));
  if (tool === 'diet') return !!(p.answers || p.meal_time || p.meal_time_local || p.meal_time_text);
  if (tool === 'emotion') return !!p.answers;
  if (tool === 'sleep') return !!p.quality && !!(p.bedtime || p.bedtime_local || p.bedtime_text) && !!(p.wake_time || p.wake_time_local || p.wake_time_text);
  return !!p.completed_at;
}

async function submitRecord(userId, tool, p) {
  const record = String(p.record_id || ''); if (!/^[a-f0-9-]{36}$/i.test(record)) throw Object.assign(new Error('record_id 必须为 UUID'), { status:400, code:'validation_error' });
  const exist = await db.one(`SELECT * FROM healtools_task_records WHERE record_uuid=?`, [record]); if (exist) return { record_id:record, server_version:Number(exist.server_version), task_status:exist.status, star_delta:0, duplicate:true, ...(await starSummary(userId)) };
  const h = await healthDate(userId); const hd = String(p.health_date || h.health_date); const role = String(p.role || 'free'); const card = p.card_no ? Number(p.card_no) : null; const done = completed(tool, p); const late = done && role === 'core' && hd !== h.health_date; const now = nowSql();
  let starDelta = 0, cardStatus = null;
  await db.tx(async conn => {
    await conn.execute(`INSERT INTO healtools_task_records(record_uuid,user_id,health_date,card_no,tool_type,role,status,started_at,completed_at,client_created_at,client_updated_at,server_version,payload_json) VALUES(?,?,?,?,?,?,?,NULL,?,NULL,NULL,1,?)`, [record,userId,hd,card,tool,role,late?'late_record':done?'completed':'partial',done?now:null,JSON.stringify(p)]);
    if (done && !late && role === 'core' && card >= 1 && card <= 3) {
      let [rows] = await conn.execute(`SELECT * FROM healtools_daily_cards WHERE user_id=? AND health_date=? AND card_no=? AND active=1 FOR UPDATE`, [userId,hd,card]); let row = rows[0];
      const actionId = String(p.action_id || '');
      if ((!row || row.core_task_type !== tool) && ACTIONS[actionId]) {
        const a = ACTIONS[actionId], plan = row && row.plan_id ? row.plan_id : uuid();
        if (row) await conn.execute(`UPDATE healtools_daily_cards SET core_task_type=?,core_mode_id=?,action_id=?,title=?,duration_sec=?,reason_text='由已批准的离线推荐卡恢复。',plan_id=?,source='client_approved_restore',active=1,status='open',updated_at=? WHERE id=?`, [a.tool,a.mode,a.action_id,a.title,a.duration_sec,plan,now,row.id]);
        else await conn.execute(`INSERT INTO healtools_daily_cards(user_id,health_date,card_no,core_task_type,core_mode_id,action_id,title,duration_sec,reason_text,plan_id,source,active,light_mode,status,star_awarded,server_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,? ,?,'client_approved_restore',1,0,'open',0,1,?,?)`, [userId,hd,card,a.tool,a.mode,a.action_id,a.title,a.duration_sec,'由已批准的离线推荐卡恢复。',plan,now,now]);
        [rows] = await conn.execute(`SELECT * FROM healtools_daily_cards WHERE user_id=? AND health_date=? AND card_no=? AND active=1 FOR UPDATE`, [userId,hd,card]); row = rows[0];
      }
      if (row && row.status !== 'completed' && row.core_task_type === tool) {
        const mode = String(p.mode_id || p.checkin_type || p.assessment_type || '');
        const modeOk = !mode || ['diet','emotion','sleep'].includes(tool) || row.core_mode_id === mode;
        if (modeOk) {
          await conn.execute(`UPDATE healtools_daily_cards SET status='completed',completed_at=?,star_awarded=1,server_version=server_version+1,updated_at=? WHERE id=?`, [now,now,row.id]);
          const award = `base:${userId}:${hd}:${card}`;
          try { await conn.execute(`INSERT INTO healtools_star_ledger(ledger_uuid,user_id,health_date,card_no,delta,reason,award_key,source_record_uuid,created_at) VALUES(?,?,?,?,1,'recommended_card',?,?,?)`, [uuid(),userId,hd,card,award,record,now]); starDelta = 1; } catch (e) { if (e.code !== 'ER_DUP_ENTRY') throw e; }
          cardStatus = 'completed';
        }
      }
    }
  });
  return { record_id:record, server_version:1, task_status:late?'late_record':done?'completed':'partial', card_status:cardStatus, star_delta:starDelta, ...(await starSummary(userId)) };
}

async function usageEvent(userId, event, params={}) { await db.query(`INSERT INTO healtools_usage_events(user_id,event_name,health_date,params_json,created_at) VALUES(?,?,?,?,?)`, [userId || null,event,params.health_date || null,JSON.stringify(params || {}),nowSql()]); }

module.exports = { uuid, nowSql, ensureUser, profile, routine, healthDate, starSummary, apiCards, currentCards, applyPlan, ensurePlan, submitRecord, usageEvent };

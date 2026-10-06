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


function parsePayload(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch (_) { return {}; }
}
function timeMinutes(v) {
  const m = String(v || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}
function sleepHours(bed, wake) {
  const b = timeMinutes(bed), w = timeMinutes(wake);
  if (b === null || w === null) return null;
  let d = w - b; if (d <= 0) d += 24 * 60;
  if (d <= 0 || d > 16 * 60) return null;
  return Math.round(d / 6) / 10;
}
async function recentHealthContext(userId) {
  const h = await healthDate(userId);
  const yesterday = DateTime.fromISO(h.health_date).minus({ days:1 }).toISODate();
  const from = DateTime.fromISO(h.health_date).minus({ days:7 }).toISODate();
  const rows = await db.query(`SELECT DATE_FORMAT(health_date,'%Y-%m-%d') health_date,tool_type,status,completed_at,payload_json FROM healtools_task_records WHERE user_id=? AND health_date BETWEEN ? AND ? AND tool_type IN ('sleep','diet') AND deleted_at IS NULL AND status IN ('completed','partial') ORDER BY COALESCE(completed_at, health_date) DESC,id DESC LIMIT 80`, [userId, from, h.health_date]);
  const parsed = rows.map(r => ({ ...r, payload:parsePayload(r.payload_json) }));
  const sleepRows = parsed.filter(r => r.tool_type === 'sleep' && Number(r.payload?.quality || 0) > 0);
  const dietRows = parsed.filter(r => r.tool_type === 'diet');
  const sleepYesterday = sleepRows.find(r => String(r.payload?.sleep_date || '') === yesterday) || null;
  const dietYesterday = dietRows.find(r => String(r.health_date || '').slice(0,10) === yesterday) || null;
  const recentSleep = sleepRows.slice(0,7);
  const recentDiet = dietRows.filter(r => String(r.health_date || '').slice(0,10) >= from).slice(0,14);
  const sleepQualities = recentSleep.map(r => Number(r.payload?.quality || 0)).filter(x => x >= 1 && x <= 5);
  const avgSleepQuality = sleepQualities.length ? Math.round((sleepQualities.reduce((a,b)=>a+b,0) / sleepQualities.length) * 10) / 10 : null;
  const irregularDietDays = recentDiet.filter(r => ['有一点','有'].includes(String(r.payload?.answers?.regularity || ''))).length;
  const heavyDietDays = recentDiet.filter(r => Array.isArray(r.payload?.answers?.night) && r.payload.answers.night.length).length;
  const sy = sleepYesterday?.payload || null, dy = dietYesterday?.payload || null;
  const sleepGentle = !!(sy && (Number(sy.quality || 0) <= 2 || Number(sy.sleep_latency_min || 0) >= 30 || Number(sy.awakenings || 0) >= 2)) || (sleepQualities.length >= 3 && Number(avgSleepQuality) < 3);
  const dietAttention = !!(dy && (['有一点','有'].includes(String(dy.answers?.regularity || '')) || (Array.isArray(dy.answers?.night) && dy.answers.night.length))) || irregularDietDays >= 2 || heavyDietDays >= 2;
  return {
    health_date:h.health_date,
    yesterday,
    sleep:{
      available:!!sy,
      quality:sy ? Number(sy.quality || 0) : null,
      latency_min:sy?.sleep_latency_min !== undefined ? Number(sy.sleep_latency_min) : null,
      awakenings:sy?.awakenings !== undefined ? Number(sy.awakenings) : null,
      bedtime_text:sy ? String(sy.bedtime_text || sy.bedtime || '') : '',
      wake_time_text:sy ? String(sy.wake_time_text || sy.wake_time || '') : '',
      approx_hours:sy ? sleepHours(sy.bedtime_text || sy.bedtime, sy.wake_time_text || sy.wake_time) : null,
      recent_count:sleepQualities.length,
      recent_avg_quality:avgSleepQuality
    },
    diet:{
      available:!!dy,
      meal_time_text:dy ? String(dy.meal_time_text || dy.meal_time || '') : '',
      regularity:dy ? String(dy.answers?.regularity || '') : '',
      plate:dy && Array.isArray(dy.answers?.plate) ? dy.answers.plate.map(String) : [],
      night:dy && Array.isArray(dy.answers?.night) ? dy.answers.night.map(String) : [],
      recent_count:recentDiet.length,
      recent_irregular_days:irregularDietDays,
      recent_night_flag_days:heavyDietDays
    },
    signals:{ sleep_gentle:sleepGentle, diet_attention:dietAttention },
    history_days:new Set(parsed.map(r => String(r.health_date || '').slice(0,10)).filter(Boolean)).size
  };
}
function dailyInsightFromContext(ctx) {
  const items = [];
  const s = ctx.sleep || {}, d = ctx.diet || {};
  if (s.available) {
    const facts = [];
    if (s.quality) facts.push(`主观睡眠质量 ${s.quality}/5`);
    if (s.approx_hours) facts.push(`按记录时间约 ${s.approx_hours} 小时`);
    let advice = '今天保持稳定作息和低负担练习即可。';
    if (Number(s.quality || 0) <= 2) advice = '昨天的主观睡眠评分较低，今天更适合低负担的放松练习；晚上按平时节奏收束，不需要为了“补回来”而加量。';
    else if (Number(s.latency_min || 0) >= 30) advice = '你记录的入睡等待较长；今晚可以把睡前一小段时间留给低刺激活动或 3 分钟放松练习。';
    else if (Number(s.awakenings || 0) >= 2) advice = '你记录了多次夜间醒来；今天的练习可以保持轻量，晚上尽量维持熟悉的睡前节奏。';
    else if (Number(s.quality || 0) >= 4) advice = '昨天的主观睡眠感受较好，今天保持稳定节奏即可，不需要额外加量。';
    items.push({ type:'sleep', title:'睡眠', summary:facts.join(' · ') || '已记录昨晚睡眠', text:advice });
  } else {
    items.push({ type:'sleep', title:'睡眠', summary:'昨天还没有睡眠回顾', text:'完成一次“昨晚回顾”后，明天这里会结合你的记录给出更贴合的日常提示。' });
  }
  if (d.available) {
    const notes = [];
    if (d.regularity) notes.push(`较长空腹：${d.regularity}`);
    if (d.plate?.length) notes.push(`这一餐记录：${d.plate.join('、')}`);
    if (d.night?.length) notes.push(`晚间记录：${d.night.join('、')}`);
    const tips = [];
    if (['有一点','有'].includes(d.regularity)) tips.push('今天可以尽量把进食间隔安排得更平稳');
    if (d.plate?.length) {
      const missing = ['主食','蛋白','蔬菜'].filter(x => !d.plate.includes(x));
      if (missing.length) tips.push(`下一餐如果方便，可以考虑补上${missing.join('、')}`);
    }
    if (d.night?.includes('很撑')) tips.push('今晚可以给自己留一点余量，避免吃到很撑');
    if (d.night?.some(x => ['很辣','很油'].includes(x))) tips.push('今晚可以试试相对清淡一点');
    if (d.night?.includes('饮酒')) tips.push('如果今天也饮酒，尽量控制量，并避免临睡前继续饮用');
    items.push({ type:'diet', title:'饮食', summary:notes.join(' · ') || '已记录昨天饮食', text:tips.length ? `${tips.join('；')}。` : '昨天的记录没有提示需要额外调整，今天继续用简单、规律的方式记录即可。' });
  } else {
    items.push({ type:'diet', title:'饮食', summary:'昨天还没有晚餐记录', text:'完成一次晚餐快速记录后，明天这里会结合进食节奏和餐盘内容给出简短提示。' });
  }
  return {
    health_date:ctx.health_date,
    based_on_date:ctx.yesterday,
    available:!!(s.available || d.available),
    title:'昨天的睡眠与饮食提示',
    items,
    note:'只根据你自己记录的生活方式信息做日常提示，不是医学诊断、风险预测或治疗建议。'
  };
}
async function dailyInsight(userId) { return dailyInsightFromContext(await recentHealthContext(userId)); }

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
  const h = await healthDate(userId);
  const hd = h.health_date;
  const existing = await currentCards(userId, hd);
  const completed = existing.filter(x => x.status === 'completed');
  const allDone = existing.length > 0 && completed.length === existing.length;
  const replan = !!context.replan;

  if (allDone && !replan) return existing;

  let target = Math.max(1, Math.min(3, actions.length || 1));
  if (completed.length && !allDone) target = existing.length;

  const planId = uuid();
  const now = nowSql();
  const snapshot = JSON.stringify({
    quick_intents:context.quick_intents || [],
    light_day:!!light,
    history_used:!!context.history_used,
    replan,
    timezone:h.timezone
  });

  await db.tx(async conn => {
    const [mxRows] = await conn.execute(
      `SELECT card_no FROM healtools_daily_cards WHERE user_id=? AND health_date=? ORDER BY card_no DESC LIMIT 1 FOR UPDATE`,
      [userId, hd]
    );
    let maxNo = Number(mxRows?.[0]?.card_no || 0);

    if (allDone && replan) {
      if (maxNo + target > 120) return;
      await conn.execute(
        `UPDATE healtools_daily_cards SET active=0,updated_at=? WHERE user_id=? AND health_date=? AND active=1`,
        [now, userId, hd]
      );
      for (let i=0; i<target; i++) {
        const a = actions[i] || actions[0];
        if (!a) continue;
        if (maxNo >= 120) break;
        const cardNo = ++maxNo;
        await conn.execute(
          `INSERT INTO healtools_daily_cards(user_id,health_date,card_no,core_task_type,core_mode_id,action_id,title,duration_sec,reason_text,plan_id,source,active,light_mode,schedule_snapshot_json,status,star_awarded,server_version,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?, 'open',0,1,?,?)`,
          [userId,hd,cardNo,a.tool,a.mode,a.action_id,a.title,a.duration_sec,a.reason || '',planId,source,light?1:0,snapshot,now,now]
        );
      }
      return;
    }

    if (existing.length) {
      if (completed.length) {
        let next = 0;
        for (const old of existing) {
          if (old.status === 'completed') {
            await conn.execute(
              `UPDATE healtools_daily_cards SET plan_id=?,active=1,updated_at=? WHERE id=?`,
              [planId, now, old.id]
            );
            continue;
          }
          const a = actions[next++];
          if (!a) {
            await conn.execute(`UPDATE healtools_daily_cards SET plan_id=?,active=1,updated_at=? WHERE id=?`, [planId,now,old.id]);
            continue;
          }
          await conn.execute(
            `UPDATE healtools_daily_cards
             SET core_task_type=?,core_mode_id=?,action_id=?,title=?,duration_sec=?,reason_text=?,plan_id=?,source=?,active=1,light_mode=?,schedule_snapshot_json=?,status='open',completed_at=NULL,star_awarded=0,server_version=server_version+1,updated_at=?
             WHERE id=?`,
            [a.tool,a.mode,a.action_id,a.title,a.duration_sec,a.reason || '',planId,source,light?1:0,snapshot,now,old.id]
          );
        }
      } else {
        const reusable = existing.slice(0, target);
        for (let i=0; i<target; i++) {
          const a = actions[i] || actions[0];
          if (!a) continue;
          const old = reusable[i];
          if (old) {
            await conn.execute(
              `UPDATE healtools_daily_cards
               SET core_task_type=?,core_mode_id=?,action_id=?,title=?,duration_sec=?,reason_text=?,plan_id=?,source=?,active=1,light_mode=?,schedule_snapshot_json=?,status='open',completed_at=NULL,star_awarded=0,server_version=server_version+1,updated_at=?
               WHERE id=?`,
              [a.tool,a.mode,a.action_id,a.title,a.duration_sec,a.reason || '',planId,source,light?1:0,snapshot,now,old.id]
            );
          } else {
            if (maxNo >= 120) break;
            const cardNo = ++maxNo;
            await conn.execute(
              `INSERT INTO healtools_daily_cards(user_id,health_date,card_no,core_task_type,core_mode_id,action_id,title,duration_sec,reason_text,plan_id,source,active,light_mode,schedule_snapshot_json,status,star_awarded,server_version,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?, 'open',0,1,?,?)`,
              [userId,hd,cardNo,a.tool,a.mode,a.action_id,a.title,a.duration_sec,a.reason || '',planId,source,light?1:0,snapshot,now,now]
            );
          }
        }
        const keepIds = new Set(reusable.map(x => Number(x.id)));
        for (const old of existing) {
          if (!keepIds.has(Number(old.id))) {
            await conn.execute(`UPDATE healtools_daily_cards SET active=0,updated_at=? WHERE id=?`, [now, old.id]);
          }
        }
      }
      return;
    }

    for (let i=0; i<target; i++) {
      const a = actions[i] || actions[0];
      if (!a) continue;
      if (maxNo >= 120) break;
      const cardNo = ++maxNo;
      await conn.execute(
        `INSERT INTO healtools_daily_cards(user_id,health_date,card_no,core_task_type,core_mode_id,action_id,title,duration_sec,reason_text,plan_id,source,active,light_mode,schedule_snapshot_json,status,star_awarded,server_version,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?, 'open',0,1,?,?)`,
        [userId,hd,cardNo,a.tool,a.mode,a.action_id,a.title,a.duration_sec,a.reason || '',planId,source,light?1:0,snapshot,now,now]
      );
    }
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
  const record = String(p.record_id || '');
  if (!/^[a-f0-9-]{36}$/i.test(record)) throw Object.assign(new Error('record_id 必须为 UUID'), { status:400, code:'validation_error' });
  const exist = await db.one(`SELECT * FROM healtools_task_records WHERE record_uuid=?`, [record]);
  if (exist) return { record_id:record, server_version:Number(exist.server_version), task_status:exist.status, star_delta:0, duplicate:true, ...(await starSummary(userId)) };

  const h = await healthDate(userId);
  const hd = String(p.health_date || h.health_date);
  const role = String(p.role || 'free');
  const card = p.card_no ? Number(p.card_no) : null;
  const done = completed(tool, p);
  const late = done && role === 'core' && hd !== h.health_date;
  const now = nowSql();
  let starDelta = 0, cardStatus = null;

  await db.tx(async conn => {
    await conn.execute(
      `INSERT INTO healtools_task_records(record_uuid,user_id,health_date,card_no,tool_type,role,status,started_at,completed_at,client_created_at,client_updated_at,server_version,payload_json)
       VALUES(?,?,?,?,?,?,?,NULL,?,NULL,NULL,1,?)`,
      [record,userId,hd,card,tool,role,late?'late_record':done?'completed':'partial',done?now:null,JSON.stringify(p)]
    );

    if (done && !late && role === 'core' && card >= 1 && card <= 120) {
      let [rows] = await conn.execute(
        `SELECT * FROM healtools_daily_cards WHERE user_id=? AND health_date=? AND card_no=? AND active=1 FOR UPDATE`,
        [userId,hd,card]
      );
      let row = rows[0];
      const actionId = String(p.action_id || '');

      if ((!row || row.core_task_type !== tool) && ACTIONS[actionId]) {
        const a = ACTIONS[actionId], plan = row && row.plan_id ? row.plan_id : uuid();
        if (row) {
          await conn.execute(
            `UPDATE healtools_daily_cards
             SET core_task_type=?,core_mode_id=?,action_id=?,title=?,duration_sec=?,reason_text='由已批准的离线推荐卡恢复。',plan_id=?,source='client_approved_restore',active=1,status='open',updated_at=?
             WHERE id=?`,
            [a.tool,a.mode,a.action_id,a.title,a.duration_sec,plan,now,row.id]
          );
        } else {
          await conn.execute(
            `INSERT INTO healtools_daily_cards(user_id,health_date,card_no,core_task_type,core_mode_id,action_id,title,duration_sec,reason_text,plan_id,source,active,light_mode,status,star_awarded,server_version,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,'client_approved_restore',1,0,'open',0,1,?,?)`,
            [userId,hd,card,a.tool,a.mode,a.action_id,a.title,a.duration_sec,'由已批准的离线推荐卡恢复。',plan,now,now]
          );
        }
        [rows] = await conn.execute(
          `SELECT * FROM healtools_daily_cards WHERE user_id=? AND health_date=? AND card_no=? AND active=1 FOR UPDATE`,
          [userId,hd,card]
        );
        row = rows[0];
      }

      if (row && row.status !== 'completed' && row.core_task_type === tool) {
        const mode = String(p.mode_id || p.checkin_type || p.assessment_type || '');
        const modeOk = !mode || ['diet','emotion','sleep'].includes(tool) || row.core_mode_id === mode;
        if (modeOk) {
          await conn.execute(
            `UPDATE healtools_daily_cards SET status='completed',completed_at=?,star_awarded=1,server_version=server_version+1,updated_at=? WHERE id=?`,
            [now,now,row.id]
          );
          const award = `base:${userId}:${hd}:${card}`;
          try {
            await conn.execute(
              `INSERT INTO healtools_star_ledger(ledger_uuid,user_id,health_date,card_no,delta,reason,award_key,source_record_uuid,created_at)
               VALUES(?,?,?,?,1,'recommended_card',?,?,?)`,
              [uuid(),userId,hd,card,award,record,now]
            );
            starDelta = 1;
          } catch (e) {
            if (e.code !== 'ER_DUP_ENTRY') throw e;
          }
          cardStatus = 'completed';
        }
      }
    }
  });

  return { record_id:record, server_version:1, task_status:late?'late_record':done?'completed':'partial', card_status:cardStatus, star_delta:starDelta, ...(await starSummary(userId)) };
}

async function usageEvent(userId, event, params={}) { await db.query(`INSERT INTO healtools_usage_events(user_id,event_name,health_date,params_json,created_at) VALUES(?,?,?,?,?)`, [userId || null,event,params.health_date || null,JSON.stringify(params || {}),nowSql()]); }

module.exports = { uuid, nowSql, ensureUser, profile, routine, healthDate, starSummary, apiCards, currentCards, applyPlan, ensurePlan, submitRecord, usageEvent, recentHealthContext, dailyInsight };

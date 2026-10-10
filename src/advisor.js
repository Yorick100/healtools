'use strict';
const crypto = require('crypto');
const db = require('./db');
const { healthDate } = require('./domain');
const { generateLifestyleInsight } = require('./ai');

const TYPES = ['sleep', 'diet', 'emotion'];
const NAMES = { sleep: '睡眠日记', diet: '饮食计划', emotion: '情绪自评' };
function payload(v) { try { return typeof v === 'string' ? JSON.parse(v) : (v || {}); } catch (_) { return {}; } }
function adviceFallback(type, p) {
  if (type === 'sleep') return Number(p.quality || 0) <= 2 ? '你最近一次睡眠感受偏低，可以尝试固定起床时间，并在睡前预留安静放松时间。' : '可以继续保持目前适合自己的作息，并留意醒来后的精神状态。';
  if (type === 'diet') return p.answers?.regularity === '有' ? '上次提到曾长时间没有进食，可以提前准备一份简便加餐，让进食安排更从容。' : '可以尝试规律进食，并按照现有条件搭配主食、蛋白质和蔬菜。';
  return Number(p.answers?.stress || 0) >= 4 ? '上次记录的压力较高，可以短暂离开当前任务，做一小段舒适慢呼吸。' : '留意精力和压力变化，给自己留一段可实现的休息时间。';
}
function emptyResult(date) {
  return { title: '健康顾问 · 个人生活建议', health_date: date, available: false, items: [], based_on_date: '', note: '仅用于日常生活方式参考，不提供医疗诊断或治疗建议。' };
}
async function latestRecords(userId) {
  // Independently fetch the latest entry for each tool. A global LIMIT can hide
  // a user's older (but most recent) sleep entry behind many diet check-ins.
  const rows = await Promise.all(TYPES.map(async type => {
    const row = await db.one(`SELECT record_uuid,tool_type,DATE_FORMAT(health_date,'%Y-%m-%d') health_date,payload_json,
      COALESCE(completed_at,client_updated_at,client_created_at,started_at) entered_at
      FROM healtools_task_records WHERE user_id=? AND tool_type=? AND deleted_at IS NULL
      AND status IN ('completed','partial','late_record')
      ORDER BY COALESCE(completed_at,client_updated_at,client_created_at,started_at) DESC,id DESC LIMIT 1`, [userId, type]);
    return row || null;
  }));
  return rows.filter(Boolean);
}
function fingerprint(rows) {
  // Hash actual data as well as UUID, so edits with the same UUID also invalidate.
  const src = rows.map(r => `${r.tool_type}:${r.record_uuid}:${r.payload_json || ''}`).join('|');
  return crypto.createHash('sha256').update(src).digest('hex');
}
async function awaitClaim(userId, today, hash, empty) {
  // Concurrent callers await the winning writer, without launching another AI request.
  for (let i = 0; i < 55; i++) {
    await new Promise(resolve => setTimeout(resolve, 350));
    const row = await db.one('SELECT source_hash,provider,content_json,generated_at FROM healtools_advisor_insights WHERE user_id=? AND insight_date=?',[userId,today]);
    if (row?.source_hash === hash && row.provider !== 'generating' && row.provider !== 'error') {
      return { ...payload(row.content_json), provider: row.provider, cached: true, generated_at: row.generated_at };
    }
    if (row && row.source_hash !== hash) return { ...empty, provider: 'generating', pending: true };
  }
  return { ...empty, provider: 'generating', pending: true };
}
async function advisor(userId) {
  const today = (await healthDate(userId)).health_date;
  const rows = await latestRecords(userId);
  const empty = emptyResult(today);
  if (!rows.length) return { ...empty, provider: 'no_data', cached: true };
  const hash = fingerprint(rows);
  const cached = await db.one('SELECT source_hash,provider,content_json,generated_at FROM healtools_advisor_insights WHERE user_id=? AND insight_date=?',[userId,today]);
  if (cached?.source_hash === hash && cached.provider !== 'generating' && cached.provider !== 'error') {
    return { ...payload(cached.content_json), provider: cached.provider, cached: true, generated_at: cached.generated_at };
  }
  let claimed = false;
  if (!cached) {
    const q = await db.query(`INSERT IGNORE INTO healtools_advisor_insights (user_id,insight_date,source_hash,provider,content_json,generated_at) VALUES (?,?,?,'generating','{}',UTC_TIMESTAMP())`,[userId,today,hash]);
    claimed = Number(q.affectedRows) > 0;
  } else {
    const q = await db.query(`UPDATE healtools_advisor_insights SET source_hash=?,provider='generating',content_json='{}',generated_at=UTC_TIMESTAMP()
      WHERE user_id=? AND insight_date=? AND source_hash=? AND (provider<>'generating' OR generated_at<UTC_TIMESTAMP()-INTERVAL 30 SECOND)`,[hash,userId,today,cached.source_hash]);
    claimed = Number(q.affectedRows) > 0;
  }
  if (!claimed) return awaitClaim(userId,today,hash,empty);

  try {
    const result = { ...empty, available: true, based_on_date: rows[0].health_date };
    const context = { based_on_date: today };
    result.items = rows.map(row => {
      const type = row.tool_type, p = payload(row.payload_json);
      context[type] = { available:true, ...(type === 'sleep' ? {
        quality:p.quality, latency_min:p.sleep_latency_min, awakenings:p.awakenings,
        bedtime_text:p.bedtime_text, wake_time_text:p.wake_time_text
      } : type === 'diet' ? {
        meal_time_text:p.meal_time_text, regularity:p.answers?.regularity,plate:p.answers?.plate,night:p.answers?.night
      } : { energy:p.answers?.energy, stress:p.answers?.stress }) };
      return { type, title:NAMES[type], summary:`根据最近一次${NAMES[type]}输入`, source_date:row.health_date, text:adviceFallback(type,p) };
    });
    // Every AI call has a bounded timeout in src/ai.js; fallback is clearly labelled.
    let provider = 'deterministic_v046';
    try {
      const generated = await generateLifestyleInsight(context);
      if (generated) {
        for (const item of result.items) if (generated[item.type]) item.text = generated[item.type];
        if (generated.overall) result.overall = generated.overall;
        provider = 'cloudbase_ai';
      }
    } catch (err) { console.warn('[advisor] AI fallback:', String(err.message || err).slice(0,160)); }
    // Compare-and-set avoids an older inference overwriting a newer edit.
    const q = await db.query(`UPDATE healtools_advisor_insights SET provider=?,content_json=?,generated_at=UTC_TIMESTAMP()
      WHERE user_id=? AND insight_date=? AND source_hash=? AND provider='generating'`,[provider,JSON.stringify(result),userId,today,hash]);
    if (!q.affectedRows) return { ...result, provider, cached:false, stale:true };
    console.info('[advisor] completed', JSON.stringify({ provider, count:result.items.length, date:today }));
    return { ...result, provider, cached:false };
  } catch (err) {
    await db.query(`UPDATE healtools_advisor_insights SET provider='error' WHERE user_id=? AND insight_date=? AND source_hash=?`,[userId,today,hash]).catch(()=>{});
    throw err;
  }
}
module.exports = { advisor, fingerprint, latestRecords };

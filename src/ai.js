const { cloudbaseApp } = require('./cloudbase');

const INTENTS = ['energize','annoyed','stressed','relax','focus','sleep'];

function infer(text='') {
  const t = String(text || '');
  const out = [];
  const add = (x) => { if (INTENTS.includes(x) && !out.includes(x)) out.push(x); };
  if (/困|睡|晚安|入睡|夜里|准备休息|睡觉/u.test(t)) add('sleep');
  if (/压力|压得|deadline|赶工|紧绷/u.test(t)) add('stressed');
  if (/烦|焦虑|紧张|崩|心累|烦躁/u.test(t)) add('annoyed');
  if (/放松|静一静|缓一缓|休息/u.test(t)) add('relax');
  if (/专注|集中|学习|工作|写作|复习/u.test(t)) add('focus');
  if (/累|没精神|提神|清醒|疲惫|犯困/u.test(t)) add('energize');
  return out;
}

function hitsSafetyBoundary(text='') {
  return /胸痛|呼吸困难|喘不上气|昏厥|晕倒|意识不清|大量出血|抽搐|中毒|自杀|自残|想死|药物过量|过量服药|急救/u.test(String(text || '').slice(0, 200));
}

async function modelIntents(text='') {
  if (process.env.HEALTOOLS_AI_ENABLED === '0') return null;
  const modelId = process.env.CLOUDBASE_AI_MODEL;
  const app = cloudbaseApp();
  if (!app || !modelId || !String(text).trim()) return null;
  try {
    const ai = app.ai();
    const model = ai.createModel('cloudbase');
    const prompt = [
      '你是康䇿工具箱的“状态理解器”，不是医生。',
      '只把用户的日常状态映射到允许的 intent，不做诊断，不解释原因，不给治疗建议。',
      `允许值只有：${INTENTS.join(', ')}。`,
      '必须只返回 JSON，例如 {"intents":["stressed","sleep"]}。',
      '如果无法判断，返回 {"intents":[]}。',
      `用户输入：${String(text).slice(0, 200)}`
    ].join('\n');
    const result = await model.generateText({
      model: modelId,
      messages: [
        { role: 'system', content: '严格输出 JSON，不输出 Markdown，不输出诊断或建议。' },
        { role: 'user', content: prompt }
      ]
    });
    const raw = String(result && result.text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.intents)) return null;
    return parsed.intents.map(x => String(x)).filter((x, i, a) => INTENTS.includes(x) && a.indexOf(x) === i);
  } catch (_) { return null; }
}

const ACTIONS = {
  breathing_slow_exhale_60: { action_id:'breathing_slow_exhale_60', title:'1 分钟舒适慢呼吸', desc:'把注意力放回呼吸，先做一个很小的启动。', tool:'breathing', mode:'slow_exhale', duration_sec:60 },
  breathing_slow_exhale_180: { action_id:'breathing_slow_exhale_180', title:'3 分钟舒适慢呼吸', desc:'用更长一点的呼气，让节奏慢下来。', tool:'breathing', mode:'slow_exhale', duration_sec:180 },
  meditation_mindful_300: { action_id:'meditation_mindful_300', title:'5 分钟正念呼吸', desc:'短暂离开任务，把注意力带回当下。', tool:'meditation', mode:'mindful_breathing', duration_sec:300 },
  meditation_sleep_180: { action_id:'meditation_sleep_180', title:'3 分钟睡前放松', desc:'降低夜间刺激，给今天一个温和的收束。', tool:'meditation', mode:'sleep_relax', duration_sec:180 },
  diet_dinner_quick: { action_id:'diet_dinner_quick', title:'20 秒晚餐快速计划', desc:'只回答一个自然问题，不算卡路里。', tool:'diet', mode:'dinner_quick', duration_sec:20 },
  emotion_quick_check: { action_id:'emotion_quick_check', title:'10 秒状态快记', desc:'用一两次点击记录此刻精力或压力。', tool:'emotion', mode:'quick_check', duration_sec:10 },
  sleep_morning_review: { action_id:'sleep_morning_review', title:'20 秒昨晚回顾', desc:'记录上床、起床和主观睡眠感受。', tool:'sleep', mode:'morning_review', duration_sec:20 }
};

function timeContext(localHour) { if (localHour < 10) return 'morning'; if (localHour < 17) return 'day'; if (localHour < 21) return 'evening'; return 'night'; }

async function recommend({ quickIntents=[], text='', light=false, maxCards=3, localHour=12 }) {
  const intents = [];
  const addIntent = x => { if (INTENTS.includes(x) && !intents.includes(x)) intents.push(x); };
  quickIntents.forEach(addIntent);
  const aiIntents = await modelIntents(text);
  if (Array.isArray(aiIntents)) aiIntents.forEach(addIntent); else infer(text).forEach(addIntent);

  const ids = [];
  const add = id => { if (ACTIONS[id] && !ids.includes(id)) ids.push(id); };
  if (intents.includes('sleep')) { add('meditation_sleep_180'); add('breathing_slow_exhale_180'); }
  if (intents.includes('stressed')) { add('breathing_slow_exhale_60'); add('meditation_mindful_300'); }
  if (intents.includes('annoyed')) { add('breathing_slow_exhale_60'); add('meditation_mindful_300'); }
  if (intents.includes('relax')) { add(light ? 'breathing_slow_exhale_60' : 'breathing_slow_exhale_180'); add('meditation_mindful_300'); }
  if (intents.includes('focus')) { add('breathing_slow_exhale_60'); add('emotion_quick_check'); }
  if (intents.includes('energize')) { add('breathing_slow_exhale_60'); add('emotion_quick_check'); }
  const ctx = timeContext(localHour);
  if (!ids.length) {
    if (ctx === 'morning') add('emotion_quick_check');
    else if (ctx === 'evening') add('diet_dinner_quick');
    else if (ctx === 'night') add('meditation_sleep_180');
    else add('breathing_slow_exhale_60');
  }
  let count = Math.min(3, Math.max(1, intents.length || 1));
  if (intents.length >= 2 && ids.length >= 2) count = 2;
  if (intents.length >= 3 && ids.length >= 3) count = 3;
  if (light) count = Math.min(count, 2);
  count = Math.min(count, Math.max(1, Math.min(3, Number(maxCards || 3))), ids.length);
  const labels = { energize:'想提提神', annoyed:'有点烦', stressed:'压力有点大', relax:'想放松', focus:'想专注一下', sleep:'准备睡觉' };
  const basis = intents.length ? intents.map(x => labels[x] || x).join('、') : '当前时间';
  const actions = ids.slice(0, count).map(id => ({ ...ACTIONS[id], reason:`根据你现在的“${basis}”，先安排这件容易开始的小事。` }));
  return { actions, intents, time_context: ctx, provider: Array.isArray(aiIntents) ? 'cloudbase_ai' : 'deterministic_v040', fallback: !Array.isArray(aiIntents) };
}

module.exports = { INTENTS, ACTIONS, infer, hitsSafetyBoundary, recommend };

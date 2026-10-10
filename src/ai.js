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

function aiConfigured() {
  return process.env.HEALTOOLS_AI_ENABLED !== '0'
    && !!process.env.CLOUDBASE_AI_ENV_ID
    && !!process.env.CLOUDBASE_AI_API_KEY
    && !!process.env.CLOUDBASE_AI_MODEL;
}

function aiConfigDiagnostics() {
  return {
    enabled_flag: process.env.HEALTOOLS_AI_ENABLED !== '0',
    env_id_set: !!String(process.env.CLOUDBASE_AI_ENV_ID || '').trim(),
    api_key_set: !!String(process.env.CLOUDBASE_AI_API_KEY || '').trim(),
    model: String(process.env.CLOUDBASE_AI_MODEL || '').trim() || null
  };
}

function extractMessageContent(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      if (typeof part?.content === 'string') return part.content;
      return '';
    }).join('');
  }
  return '';
}

function parseIntentPayload(rawValue) {
  const raw = String(rawValue || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  if (!raw) throw new Error('AI response content is empty');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('AI response is not valid JSON');
    parsed = JSON.parse(raw.slice(start, end + 1));
  }
  if (!Array.isArray(parsed?.intents)) throw new Error('AI response missing intents array');
  return parsed.intents
    .map(x => String(x))
    .filter((x, i, a) => INTENTS.includes(x) && a.indexOf(x) === i);
}

async function modelIntents(text='') {
  if (!String(text).trim()) return null;
  if (!aiConfigured()) {
    console.warn('[HEALTOOLS AI] AI not configured; deterministic fallback', aiConfigDiagnostics());
    return null;
  }

  const envId = String(process.env.CLOUDBASE_AI_ENV_ID).trim();
  const apiKey = String(process.env.CLOUDBASE_AI_API_KEY).trim();
  const modelId = String(process.env.CLOUDBASE_AI_MODEL).trim();
  const timeoutMs = Math.min(9000, Math.max(2000, Number(process.env.CLOUDBASE_AI_TIMEOUT_MS || 7000)));
  const url = `https://${envId}.api.tcloudbasegateway.com/v1/ai/cloudbase/chat/completions`;

  const prompt = [
    '你是康䇿工具箱的“状态理解器”，不是医生。',
    '只把用户的日常状态映射到允许的 intent，不做诊断，不解释原因，不给治疗建议。',
    `允许值只有：${INTENTS.join(', ')}。`,
    '必须只返回 JSON，例如 {"intents":["stressed","sleep"]}。',
    '如果无法判断，返回 {"intents":[]}。',
    `用户输入：${String(text).slice(0, 200)}`
  ].join('\n');

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: modelId,
        reasoning_effort: 'none',
        messages: [
          { role: 'system', content: '严格输出 JSON，不输出 Markdown，不输出诊断或建议。' },
          { role: 'user', content: prompt }
        ],
        stream: false
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${errText ? `: ${errText.slice(0, 160)}` : ''}`);
    }

    const result = await response.json();
    const choice = result?.choices?.[0] || {};
    const message = choice?.message || {};
    const content = extractMessageContent(message);
    if (!String(content || '').trim()) {
      console.warn('[HEALTOOLS AI] CloudBase returned empty final content', {
        finish_reason: choice?.finish_reason || null,
        content_type: Array.isArray(message?.content) ? 'array' : typeof message?.content,
        content_length: typeof content === 'string' ? content.length : 0,
        reasoning_length: typeof message?.reasoning_content === 'string' ? message.reasoning_content.length : 0,
        completion_tokens: result?.usage?.completion_tokens ?? null,
        total_tokens: result?.usage?.total_tokens ?? null
      });
    }
    return parseIntentPayload(content);
  } catch (e) {
    console.warn('[HEALTOOLS AI] CloudBase AI fallback', {
      name: e?.name || 'Error',
      message: String(e?.message || e).slice(0, 240),
      elapsed_ms: Date.now() - startedAt,
      timeout_ms: timeoutMs
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}


function extractJsonObject(rawValue) {
  const raw = String(rawValue || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  if (!raw) throw new Error('AI response content is empty');
  try { return JSON.parse(raw); }
  catch (_) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('AI response is not valid JSON');
    return JSON.parse(raw.slice(start, end + 1));
  }
}

function safeLifestyleText(value, max=180) {
  let t = String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  if (!t) return '';
  // 日常生活方式提示不能越界到诊断、药物、治疗或风险预测。
  if (/诊断|确诊|疾病|病症|药物|用药|处方|治疗|治愈|风险概率|患病概率|就医建议/u.test(t)) return '';
  return t;
}

async function generateLifestyleInsight(ctx={}) {
  if (!aiConfigured()) return null;
  const hasSleep = !!ctx?.sleep?.available;
  const hasDiet = !!ctx?.diet?.available;
  const hasEmotion = !!ctx?.emotion?.available;
  if (!hasSleep && !hasDiet && !hasEmotion) return null;

  const envId = String(process.env.CLOUDBASE_AI_ENV_ID).trim();
  const apiKey = String(process.env.CLOUDBASE_AI_API_KEY).trim();
  const modelId = String(process.env.CLOUDBASE_AI_MODEL).trim();
  const timeoutMs = Math.min(20000, Math.max(4000, Number(process.env.CLOUDBASE_AI_TIMEOUT_MS || 15000)));
  const url = `https://${envId}.api.tcloudbasegateway.com/v1/ai/cloudbase/chat/completions`;
  const facts = {
    based_on_date:ctx?.based_on_date || ctx?.yesterday || '',
    sleep: hasSleep ? {
      quality:ctx.sleep.quality,
      approx_hours:ctx.sleep.approx_hours,
      sleep_latency_min:ctx.sleep.latency_min,
      awakenings:ctx.sleep.awakenings,
      bedtime_text:ctx.sleep.bedtime_text,
      wake_time_text:ctx.sleep.wake_time_text
    } : null,
    diet: hasDiet ? {
      meal_time_text:ctx.diet.meal_time_text,
      regularity:ctx.diet.regularity,
      plate:ctx.diet.plate,
      night:ctx.diet.night
    } : null,
    emotion: hasEmotion ? { energy:ctx.emotion.energy,stress:ctx.emotion.stress } : null
  };
  const prompt = [
    '你是康䇿工具箱的 AI 健康顾问，只做非医疗的日常生活方式提示。',
    '只能根据给出的用户记录写建议，不得补充或猜测未记录的信息。',
    '不得诊断、评估疾病风险、推荐药物、处方或治疗。',
    '建议要温和、具体、低负担，不制造焦虑，不使用绝对化语言。',
    '必须只返回 JSON：{"sleep":"...","diet":"...","emotion":"...","overall":"..."}。',
    'sleep/diet/emotion 各不超过 90 个汉字；对应记录不存在时返回空字符串。overall 可为空，不超过 80 个汉字。',
    `记录事实：${JSON.stringify(facts)}`
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method:'POST',
      headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body:JSON.stringify({
        model:modelId,
        reasoning_effort:'none',
        messages:[
          {role:'system',content:'严格输出 JSON；只做日常生活方式提示；不得诊断、治疗或推测未提供事实。'},
          {role:'user',content:prompt}
        ],
        stream:false
      }),
      signal:controller.signal
    });
    if (!response.ok) {
      const errText = await response.text().catch(()=>'');
      throw new Error(`HTTP ${response.status}${errText ? `: ${errText.slice(0,160)}` : ''}`);
    }
    const result = await response.json();
    const content = extractMessageContent(result?.choices?.[0]?.message || {});
    const parsed = extractJsonObject(content);
    const out = {
      sleep:hasSleep ? safeLifestyleText(parsed?.sleep) : '',
      diet:hasDiet ? safeLifestyleText(parsed?.diet) : '',
      emotion:hasEmotion ? safeLifestyleText(parsed?.emotion) : '',
      overall:safeLifestyleText(parsed?.overall, 140)
    };
    if ((hasSleep && !out.sleep) || (hasDiet && !out.diet) || (hasEmotion && !out.emotion)) throw new Error('AI daily insight missing required field');
    return out;
  } catch (e) {
    console.warn('[HEALTOOLS AI] daily insight model fallback', {
      name:e?.name || 'Error', message:String(e?.message || e).slice(0,220), elapsed_ms:Date.now()-startedAt, timeout_ms:timeoutMs
    });
    return null;
  } finally { clearTimeout(timer); }
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
const ALL_ACTION_IDS = Object.keys(ACTIONS);

function timeContext(localHour) { if (localHour < 10) return 'morning'; if (localHour < 17) return 'day'; if (localHour < 21) return 'evening'; return 'night'; }

async function recommend({ quickIntents=[], text='', light=false, maxCards=3, minCards=0, localHour=12, history=null, excludeActionIds=[] }) {
  const intents = [];
  const addIntent = x => { if (INTENTS.includes(x) && !intents.includes(x)) intents.push(x); };
  quickIntents.forEach(addIntent);
  const aiIntents = await modelIntents(text);
  if (Array.isArray(aiIntents)) aiIntents.forEach(addIntent); else infer(text).forEach(addIntent);

  const ctx = timeContext(localHour);
  const hist = history && typeof history === 'object' ? history : {};
  const sleepGentle = !!hist?.signals?.sleep_gentle;
  const dietAttention = !!hist?.signals?.diet_attention;

  const ids = [];
  const add = id => { if (ACTIONS[id] && !ids.includes(id)) ids.push(id); };
  if (intents.includes('sleep')) { add('meditation_sleep_180'); add('breathing_slow_exhale_180'); add('breathing_slow_exhale_60'); }
  if (intents.includes('stressed')) { add('breathing_slow_exhale_60'); add('meditation_mindful_300'); add('breathing_slow_exhale_180'); }
  if (intents.includes('annoyed')) { add('breathing_slow_exhale_60'); add('meditation_mindful_300'); add('emotion_quick_check'); }
  if (intents.includes('relax')) { add(light ? 'breathing_slow_exhale_60' : 'breathing_slow_exhale_180'); add('meditation_mindful_300'); add('emotion_quick_check'); }
  if (intents.includes('focus')) { add('breathing_slow_exhale_60'); add('emotion_quick_check'); add('meditation_mindful_300'); }
  if (intents.includes('energize')) { add('breathing_slow_exhale_60'); add('emotion_quick_check'); add('diet_dinner_quick'); }

  let historyAdds = 0;
  if (sleepGentle) {
    add('breathing_slow_exhale_60'); historyAdds++;
    if (ctx === 'night') add('meditation_sleep_180');
  }
  if (dietAttention && (ctx === 'evening' || ctx === 'night')) { add('diet_dinner_quick'); historyAdds++; }

  if (!ids.length) {
    if (ctx === 'morning') add('emotion_quick_check');
    else if (ctx === 'evening') add('diet_dinner_quick');
    else if (ctx === 'night') add('meditation_sleep_180');
    else add('breathing_slow_exhale_60');
  }
  // “重新规划”需要尽量换卡；其余白名单动作仅作为安全备选，不改变可执行动作边界。
  ALL_ACTION_IDS.forEach(add);

  let count = Math.min(3, Math.max(1, intents.length || (historyAdds > 1 ? 2 : 1)));
  if (intents.length >= 2) count = Math.max(count, 2);
  if (intents.length >= 3) count = 3;
  if (light) count = Math.min(count, 2);
  count = Math.min(count, Math.max(1, Math.min(3, Number(maxCards || 3))));
  count = Math.max(count, Math.min(3, Math.max(0, Number(minCards || 0))));

  const excluded = new Set((Array.isArray(excludeActionIds) ? excludeActionIds : []).map(String));
  let candidates = ids.filter(id => !excluded.has(id));
  // 理论上 7 个白名单动作足够支撑 1–3 张不同卡；若未来白名单缩小，才允许回退到旧动作。
  if (candidates.length < count) candidates = candidates.concat(ids.filter(id => excluded.has(id)));
  const picked = candidates.slice(0, count);

  const labels = { energize:'想提提神', annoyed:'有点烦', stressed:'压力有点大', relax:'想放松', focus:'想专注一下', sleep:'准备睡觉' };
  const basis = intents.length ? intents.map(x => labels[x] || x).join('、') : '当前时间';
  const historyBasis = [];
  if (sleepGentle) historyBasis.push('最近的睡眠记录');
  if (dietAttention) historyBasis.push('最近的饮食记录');

  const actions = picked.map(id => {
    let reason = `根据你现在的“${basis}”，先安排这件容易开始的小事。`;
    if (historyBasis.length && ['breathing_slow_exhale_60','breathing_slow_exhale_180','meditation_sleep_180','diet_dinner_quick'].includes(id)) {
      reason = `结合你现在的“${basis}”和${historyBasis.join('、')}，先安排一个更低负担、容易开始的行动。`;
    }
    return { ...ACTIONS[id], reason };
  });
  return { actions, intents, time_context:ctx, provider:Array.isArray(aiIntents) ? 'cloudbase_ai' : 'deterministic_v040', fallback:!Array.isArray(aiIntents), history_used:historyBasis.length > 0 };
}

module.exports = { INTENTS, ACTIONS, infer, hitsSafetyBoundary, recommend, aiConfigured, aiConfigDiagnostics, generateLifestyleInsight };

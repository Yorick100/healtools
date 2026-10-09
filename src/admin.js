const db = require('./db');

function basicAuth(req, res, next) {
  const user = process.env.HEALTOOLS_ADMIN_USER;
  const pass = process.env.HEALTOOLS_ADMIN_PASSWORD;
  if (!user || !pass) return res.status(503).send('管理面板尚未配置 HEALTOOLS_ADMIN_USER / HEALTOOLS_ADMIN_PASSWORD');
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Basic ')) { res.set('WWW-Authenticate','Basic realm="HEALTOOLS"'); return res.status(401).send('需要管理员登录'); }
  let pair=''; try { pair = Buffer.from(auth.slice(6), 'base64').toString('utf8'); } catch (_) {}
  const i = pair.indexOf(':');
  if (i < 0 || pair.slice(0,i) !== user || pair.slice(i+1) !== pass) { res.set('WWW-Authenticate','Basic realm="HEALTOOLS"'); return res.status(401).send('账号或密码错误'); }
  next();
}
function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
async function dashboard(req,res) {
  const started=Date.now();
  try {
  // Query failures are isolated: a bad statistic must not take down the entire admin page.
  // In particular, keep ONLY_FULL_GROUP_BY compatibility for the registration trend.
  const checks = [
    ['total','总注册人数',() => db.one(`SELECT COUNT(*) n FROM healtools_users`)],
    ['a7','近7天访问',() => db.one(`SELECT COUNT(*) n FROM healtools_users WHERE last_active_at>=UTC_TIMESTAMP()-INTERVAL 7 DAY`)],
    ['records','工具记录',() => db.one(`SELECT COUNT(*) n FROM healtools_task_records WHERE deleted_at IS NULL`)],
    ['stars','累计星星',() => db.one(`SELECT COALESCE(SUM(delta),0) n FROM healtools_star_ledger`)],
    ['ai','旧版AI事件',() => db.query(`SELECT event_name,COUNT(*) n FROM healtools_usage_events WHERE created_at>=UTC_TIMESTAMP()-INTERVAL 7 DAY AND event_name LIKE 'ai_%' GROUP BY event_name ORDER BY n DESC`)],
    ['users','最近50位用户',() => db.query(`SELECT u.user_uuid,p.nickname,u.created_at,u.last_active_at,(SELECT COALESCE(SUM(delta),0) FROM healtools_star_ledger s WHERE s.user_id=u.id) total_star,(SELECT COUNT(*) FROM healtools_task_records t WHERE t.user_id=u.id AND t.deleted_at IS NULL) records FROM healtools_users u LEFT JOIN healtools_user_profiles p ON p.user_id=u.id ORDER BY u.last_active_at DESC LIMIT 50`)],
    ['new7','7日新增',() => db.one(`SELECT COUNT(*) n FROM healtools_users WHERE created_at>=UTC_TIMESTAMP()-INTERVAL 7 DAY`)],
    ['new30','30日新增',() => db.one(`SELECT COUNT(*) n FROM healtools_users WHERE created_at>=UTC_TIMESTAMP()-INTERVAL 30 DAY`)],
    ['mau','30日活跃',() => db.one(`SELECT COUNT(DISTINCT user_id) n FROM healtools_user_daily_activity WHERE activity_date>=UTC_DATE()-INTERVAL 29 DAY`)],
    ['dau','今日活跃',() => db.one(`SELECT COUNT(DISTINCT user_id) n FROM healtools_user_daily_activity WHERE activity_date=UTC_DATE()`)],
    ['act','活跃趋势',() => db.query(`SELECT DATE_FORMAT(activity_date,'%m-%d') day,COUNT(DISTINCT user_id) n FROM healtools_user_daily_activity WHERE activity_date>=UTC_DATE()-INTERVAL 29 DAY GROUP BY activity_date ORDER BY activity_date`)],
    ['toolUsage','工具统计',() => db.query(`SELECT tool_type,COUNT(*) n,COUNT(DISTINCT user_id) people FROM healtools_task_records WHERE deleted_at IS NULL GROUP BY tool_type ORDER BY n DESC`)],
    // Use a derived DATE column rather than selecting a formatted timestamp while grouping by DATE(timestamp).
    ['trend','注册趋势',() => db.query(`SELECT DATE_FORMAT(reg_day,'%m-%d') day,COUNT(*) n FROM (SELECT DATE(created_at) reg_day FROM healtools_users WHERE created_at>=UTC_TIMESTAMP()-INTERVAL 30 DAY) d GROUP BY reg_day ORDER BY reg_day`)],
    ['aiCount','顾问生成统计',() => db.query(`SELECT provider,COUNT(*) n FROM healtools_advisor_insights WHERE insight_date>=UTC_DATE()-INTERVAL 7 DAY GROUP BY provider`)],
    ['retention','活跃留存',() => db.query(`SELECT DATEDIFF(a.activity_date,DATE(u.created_at)) offset_day,COUNT(DISTINCT a.user_id) n FROM healtools_user_daily_activity a JOIN healtools_users u ON u.id=a.user_id WHERE DATEDIFF(a.activity_date,DATE(u.created_at)) IN (1,7,30) GROUP BY offset_day`)]
  ];
  const results=await Promise.allSettled(checks.map(([, ,run])=>run()));
  const data=Object.create(null);
  const problems=[];
  results.forEach((result,i)=>{
    const [key,label]=checks[i];
    if(result.status==='fulfilled') data[key]=result.value;
    else {
      data[key]=null;
      problems.push(label);
      const err=result.reason||new Error('unknown');
      console.error('[admin] stat query failed',JSON.stringify({metric:key,label,code:err.code||'unknown',message:String(err.message||err).slice(0,240),request_id:req.requestId}));
    }
  });
  if(problems.length===checks.length) throw new Error('all_admin_statistics_failed');
  const stat=(name)=>data[name]||{n:'—'};
  const rows=(name)=>Array.isArray(data[name])?data[name]:[];
  const [total,a7,records,stars,ai,users,new7,new30,mau,dau,act,toolUsage,trend,aiCount,retention]=[
    stat('total'),stat('a7'),stat('records'),stat('stars'),rows('ai'),rows('users'),stat('new7'),stat('new30'),
    stat('mau'),stat('dau'),rows('act'),rows('toolUsage'),rows('trend'),rows('aiCount'),rows('retention')
  ];
  const warning=problems.length?`<div role="status" style="padding:14px;border:1px solid #b6865b;border-radius:12px;background:#433b31;margin:18px 0">部分统计暂时不可用：${problems.map(esc).join('、')}。其他统计仍可查阅。请将请求编号 ${esc(req.requestId)} 提供给管理员，并检查云托管日志中的 [admin] stat query failed。</div>`:'';
  const exportRows=users.map(x=>[x.nickname||'未设置',x.user_uuid,x.created_at,x.last_active_at,x.total_star,x.records]);
  const filtered=String(req.query.q||'').trim().toLowerCase();
  const visible=users.filter(x=>!filtered || String(x.nickname||'').toLowerCase().includes(filtered) || String(x.user_uuid).toLowerCase().includes(filtered));
  const trs=visible.map(x=>`<tr><td>${esc(x.nickname||'未设置')}</td><td><code>${esc(x.user_uuid)}</code></td><td>${esc(x.total_star)}</td><td>${esc(x.records)}</td><td>${esc(x.created_at)}</td><td>${esc(x.last_active_at||'')}</td></tr>`).join('');
  const trendBars=arr=>{const max=Math.max(1,...arr.map(x=>Number(x.n)));return `<div class="bars">${arr.map(x=>`<div title="${esc(x.day)}：${esc(x.n)}" class="bar" style="height:${Math.max(5,Number(x.n)/max*110)}px"></div>`).join('')}</div><div class="muted">最近30天 · 每柱一天有数据的日期（未记录日期为空）</div>`;};
  const stats=[['总注册',total.n],['新增7日',new7.n],['新增30日',new30.n],['今日活跃(UTC)',dau.n],['7日内访问',a7.n],['30日活跃',mau.n],['工具记录',records.n],['累计星星',stars.n]];
  const nav='<nav><a href="#overview">总览</a><a href="#trends">趋势</a><a href="#tools">工具</a><a href="#ai">AI 顾问</a><a href="#users">用户</a></nav>';
  res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');res.set('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.set('X-HEALTOOLS-Admin', '0.4.6.1-adminfix');res.type('html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>康䇿 · 运营数据中心</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0b1d2b;color:#edf8f5;margin:0;padding:22px}main{max-width:1180px;margin:auto}nav{display:flex;flex-wrap:wrap;gap:12px;margin:20px 0}a{color:#8de8ce}nav a,.tag{padding:8px 12px;border-radius:12px;background:#203b48;text-decoration:none}h1{margin-bottom:5px}h2{margin:36px 0 14px}p,.muted{color:#adc7c8}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px}.card,.panel{padding:18px;border:1px solid #365965;border-radius:18px;background:#183642}.num{font-size:29px;color:#9de9ce;font-weight:750}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}.bars{display:flex;align-items:end;gap:5px;min-height:120px;margin-bottom:10px}.bar{background:#88d6bf;min-width:5px;flex:1;border-radius:5px 5px 0 0}table{width:100%;border-collapse:collapse;min-width:660px}td,th{padding:12px;border-bottom:1px solid #34515b;text-align:left;font-size:13px}code{font-size:11px;color:#a9e6cf}input,button{background:#102c39;color:white;border:1px solid #53716f;border-radius:9px;padding:10px}button{cursor:pointer}.scroll{overflow-x:auto}</style></head><body><main><h1>康䇿 · 运营数据中心</h1><p>HEALTOOLS CloudRun v0.4.6.1 · 后台 SQL 修复版 · 以 UTC 日期为准（用户本地日活按个人健康日期记录）</p>${warning}${nav}<section id="overview"><h2>数据总览</h2><div class="cards">${stats.map(x=>`<div class="card"><div class="num">${esc(x[1])}</div><div>${esc(x[0])}</div></div>`).join('')}</div></section><section id="trends"><h2>近 30 天趋势</h2><div class="grid"><div class="panel"><h3>注册人数</h3>${trendBars(trend)}</div><div class="panel"><h3>活跃用户（按用户健康日期）</h3>${trendBars(act)}</div></div><p>提醒：历史日活数据从升级部署并执行迁移后开始累计，之前无法补齐；留存需要用户达到对应注册天数后才有意义。</p><div class="panel">活跃留存计数（按入站记录）：${retention.map(x=>`${esc(x.offset_day)} 日：${esc(x.n)} 人`).join(' · ')||'暂无足够数据'}</div></section><section id="tools"><h2>工具统计</h2><div class="panel scroll"><table><tr><th>工具</th><th>使用记录</th><th>使用人数</th></tr>${toolUsage.map(x=>`<tr><td>${esc(x.tool_type)}</td><td>${esc(x.n)}</td><td>${esc(x.people)}</td></tr>`).join('')}</table></div></section><section id="ai"><h2>AI 顾问统计（最近7天）</h2><div class="panel"><p>${aiCount.map(x=>`${esc(x.provider)}：${esc(x.n)}`).join(' · ')||'暂未生成分析'}</p><div class="muted">旧版 AI 事件：${ai.map(x=>`${esc(x.event_name)} ${esc(x.n)}`).join(' · ')||'暂无'}</div></div></section><section id="users"><h2>最近 50 位用户</h2><p>为减少敏感信息暴露，这里仅展示昵称和系统随机 UUID，不展示 openid 或原始健康记录。</p><form method="get" action="/admin"><input name="q" value="${esc(req.query.q||'')}" placeholder="昵称或 UUID 筛选本页50位用户"><button type="submit">查找</button><a class="tag" href="/admin">重置</a></form><div class="panel scroll"><table><tr><th>昵称</th><th>UUID</th><th>星星</th><th>工具记录</th><th>注册 UTC</th><th>最近活跃 UTC</th></tr>${trs}</table></div></section></main></body></html>`);

  console.info('[admin] rendered',JSON.stringify({elapsed_ms:Date.now()-started,request_id:req.requestId,failed_metrics:problems}));
  } catch(err) {
    console.error('[admin] database query failed',JSON.stringify({code:err.code||'unknown',message:String(err.message||err).slice(0,240),elapsed_ms:Date.now()-started,request_id:req.requestId}));
    if(!res.headersSent)res.status(503).type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>HEALTOOLS 后台暂不可用</title><body><h2>运营后台暂时无法查询数据库</h2><p>请检查云托管日志，并在同一域名访问 /system/ready。</p><p>请求编号：${esc(req.requestId)}</p></body></html>`);
  }
}
module.exports = { basicAuth, dashboard };

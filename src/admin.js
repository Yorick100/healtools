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
  const total = await db.one(`SELECT COUNT(*) n FROM healtools_users`);
  const a24 = await db.one(`SELECT COUNT(*) n FROM healtools_users WHERE last_active_at>=UTC_TIMESTAMP()-INTERVAL 1 DAY`);
  const a7 = await db.one(`SELECT COUNT(*) n FROM healtools_users WHERE last_active_at>=UTC_TIMESTAMP()-INTERVAL 7 DAY`);
  const records = await db.one(`SELECT COUNT(*) n FROM healtools_task_records WHERE deleted_at IS NULL`);
  const stars = await db.one(`SELECT COALESCE(SUM(delta),0) n FROM healtools_star_ledger`);
  const ai = await db.query(`SELECT event_name,COUNT(*) n FROM healtools_usage_events WHERE created_at>=UTC_TIMESTAMP()-INTERVAL 7 DAY AND event_name LIKE 'ai_%' GROUP BY event_name ORDER BY n DESC`);
  const users = await db.query(`SELECT u.user_uuid,p.nickname,u.created_at,u.last_active_at,(SELECT COALESCE(SUM(delta),0) FROM healtools_star_ledger s WHERE s.user_id=u.id) total_star,(SELECT COUNT(*) FROM healtools_task_records t WHERE t.user_id=u.id AND t.deleted_at IS NULL) records FROM healtools_users u LEFT JOIN healtools_user_profiles p ON p.user_id=u.id ORDER BY u.last_active_at DESC LIMIT 50`);
  const trs = users.map(x=>`<tr><td>${esc(x.nickname || '未设置')}</td><td><code>${esc(x.user_uuid)}</code></td><td>${esc(x.total_star)}</td><td>${esc(x.records)}</td><td>${esc(x.last_active_at || '')}</td></tr>`).join('');
  const aiRows = ai.map(x=>`<li>${esc(x.event_name)}：${esc(x.n)}</li>`).join('') || '<li>暂无</li>';
  res.type('html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>康䇿工具箱 · 云端面板</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b1d2b;color:#eef8f5;margin:0;padding:28px}.wrap{max-width:1080px;margin:auto}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.card{background:rgba(18,42,56,.88);border:1px solid rgba(190,240,225,.18);border-radius:18px;padding:18px}.n{font-size:30px;font-weight:700;color:#82dbc0}.muted{color:#b4c6cc}table{width:100%;border-collapse:collapse;margin-top:12px;background:rgba(18,42,56,.66);border-radius:16px;overflow:hidden}th,td{text-align:left;padding:12px;border-bottom:1px solid rgba(255,255,255,.08);font-size:14px}code{font-size:12px;color:#b9e9dc}h1{margin:0 0 4px}h2{margin-top:30px}</style></head><body><div class="wrap"><h1>康䇿工具箱 HEALTOOLS</h1><div class="muted">微信云托管 v0.4.0 · 数据为实时汇总</div><div class="cards" style="margin-top:18px"><div class="card"><div class="n">${esc(total.n)}</div><div>总用户</div></div><div class="card"><div class="n">${esc(a24.n)}</div><div>24h 活跃</div></div><div class="card"><div class="n">${esc(a7.n)}</div><div>7d 活跃</div></div><div class="card"><div class="n">${esc(records.n)}</div><div>工具记录</div></div><div class="card"><div class="n">${esc(stars.n)}</div><div>累计星星</div></div></div><h2>最近 7 天 AI顾问事件</h2><ul>${aiRows}</ul><h2>最近用户</h2><table><thead><tr><th>昵称</th><th>User ID</th><th>星星</th><th>记录</th><th>最近活跃(UTC)</th></tr></thead><tbody>${trs}</tbody></table></div></body></html>`);
}
module.exports = { basicAuth, dashboard };

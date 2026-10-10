'use strict';

// 微信云托管云调用代理：需先在「云调用 → 云调用权限配置」允许 /wxa/msg_sec_check。
// 不使用小程序端的 AppSecret，不把待审内容写入日志、数据库或缓存。
const MODERATION_URL = 'http://api.weixin.qq.com/wxa/msg_sec_check';

class UgcCheckError extends Error {
  constructor(code, message, status=503) {
    super(message);
    this.name = 'UgcCheckError';
    this.code = code;
    this.status = status;
  }
}

function assessWechatResponse(data) {
  if (!data || typeof data !== 'object' || Number(data.errcode) !== 0) {
    return 'unavailable';
  }
  const suggest = String(data.result?.suggest || '').toLowerCase();
  if (suggest === 'pass') return 'pass';
  if (suggest === 'risky') return 'blocked';
  if (suggest === 'review') return 'review';
  return 'unavailable'; // 禁止将没有 result.suggest 的返回误判为通过。
}

function createChecker({ fetchImpl=globalThis.fetch, timeoutMs=5000 }={}) {
  return async function checkText({ content, openid, scene }) {
    const text = String(content || '').trim();
    if (!text) return { checked:false, skipped:'empty' }; // 预设选项或完全空白不用调用。
    if (![1,2,3,4].includes(scene) || !openid || typeof openid !== 'string') {
      throw new UgcCheckError('ugc_check_unavailable', '内容安全服务暂不可用，请稍后再试');
    }
    if ([...text].length > 2500) {
      throw new UgcCheckError('ugc_input_invalid', '输入内容过长，请缩短后重试', 400);
    }
    if (typeof fetchImpl !== 'function') {
      throw new UgcCheckError('ugc_check_unavailable', '内容安全服务暂不可用，请稍后再试');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let outcome='unavailable';
    try {
      const response=await fetchImpl(MODERATION_URL, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({openid,version:2,scene,content:text}),
        signal:controller.signal
      });
      if (!response.ok) throw new Error('ugc_http_failure');
      const data = await response.json();
      outcome=assessWechatResponse(data);
    } catch (_) {
      // 不输出 body、微信返回的 errMsg 或待审文本，以免泄露昵称和健康输入。
      outcome='unavailable';
    } finally {
      clearTimeout(timer);
    }
    console.info('[ugc] check', JSON.stringify({scene, outcome}));
    if (outcome==='pass') return { checked:true, outcome:'pass' };
    if (outcome==='blocked') throw new UgcCheckError('ugc_content_blocked', '输入内容未通过平台安全检测，请修改后重试', 422);
    if (outcome==='review') throw new UgcCheckError('ugc_review_required', '输入内容需要进一步审核，暂不能提交，请调整后重试', 422);
    throw new UgcCheckError('ugc_check_unavailable', '内容安全检测暂不可用，内容未提交，请稍后重试');
  };
}

const checkText = createChecker();
module.exports = { checkText, createChecker, assessWechatResponse, UgcCheckError };

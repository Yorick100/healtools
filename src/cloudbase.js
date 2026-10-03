let app = null;
function cloudbaseApp() {
  if (app !== null) return app || null;
  try {
    const tcb = require('@cloudbase/node-sdk');
    const env = process.env.CLOUDBASE_ENV_ID;
    if (!env) { app = false; return null; }
    const opts = { env, timeout: 60000 };
    // 独立 Node.js / 云托管服务按 CloudBase 官方 Node SDK 文档使用腾讯云 API 密钥。
    // 不把任何密钥写进客户端或 Git。
    if (process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY) {
      opts.secretId = process.env.TENCENTCLOUD_SECRETID;
      opts.secretKey = process.env.TENCENTCLOUD_SECRETKEY;
    }
    app = tcb.init(opts);
    return app;
  } catch (_) { app = false; return null; }
}
module.exports = { cloudbaseApp };

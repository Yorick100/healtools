let app = null;
function cloudbaseApp() {
  if (app !== null) return app || null;
  try {
    const tcb = require('@cloudbase/node-sdk');
    // v0.4.2: 只为“私有数据导出到 CloudBase 存储”保留，和 AI 环境彻底解耦。
    // 未配置 CLOUDBASE_EXPORT_ENV_ID 时，/data-export 会直接返回 JSON，不上传云存储。
    const env = process.env.CLOUDBASE_EXPORT_ENV_ID;
    if (!env) { app = false; return null; }
    const opts = { env, timeout: 60000 };
    if (process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY) {
      opts.secretId = process.env.TENCENTCLOUD_SECRETID;
      opts.secretKey = process.env.TENCENTCLOUD_SECRETKEY;
    }
    app = tcb.init(opts);
    return app;
  } catch (_) { app = false; return null; }
}
module.exports = { cloudbaseApp };

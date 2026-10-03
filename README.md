# 康䇿工具箱 HEALTOOLS CloudRun v0.4.0

这是 v0.4.0 的微信云原生后端，替代 sparkpos.cn / WordPress 插件作为小程序运行时云端。

## 架构

- 小程序通过 `wx.cloud.callContainer` 调用微信云托管，不再依赖 `request` 合法域名，也不再向客户端下发自定义 access/refresh token。
- 微信云托管注入的 `x-wx-openid` / `x-wx-appid` 作为可信身份入口，后端映射到 HEALTOOLS `user_uuid`。
- 云托管 MySQL 保存用户、推荐卡、五类工具记录、星星、同步与埋点，是行为事实的权威存储。
- CloudBase AI+ 只把自由文本映射到有限 intent；真正可执行动作仍由服务端 Action Library 白名单决定。
- 音频放 CloudBase 对象存储；`scripts/upload-audio.js` 批量上传并生成 `config/audio-files.json`。
- `/admin` 保留轻量统计面板；由 Basic Auth 环境变量保护。

## 必需环境变量

复制 `.env.example` 的键到微信云托管服务环境变量。真实数据库密码、腾讯云 SecretKey、管理员密码绝不能写入 Git。

MySQL 地址使用控制台显示的内网地址。数据库建议把 `character_set_server` 改为 `utf8mb4` 并重启；本服务创建的表本身也固定使用 `utf8mb4`。

## AI+

1. 云开发控制台 → AI → 生文模型，开启要使用的模型。
2. 把模型 ID 写入 `CLOUDBASE_AI_MODEL`。
3. `CLOUDBASE_ENV_ID` 填云开发环境 ID。
4. 独立 Node.js/云托管服务按官方 Node SDK 方式配置 `TENCENTCLOUD_SECRETID` / `TENCENTCLOUD_SECRETKEY`。
5. `HEALTOOLS_AI_ENABLED=1`。

AI 不可用、超时或未配置时，服务会自动退回 `deterministic_v040`，小程序仍能完整工作。

## 音频对象存储

把旧 release 中的 `HealTools_ServerAssets_v0.2.0.zip` 解压到本项目 `server_assets/v0.2.0/`，然后在本地：

```bash
npm install
npm run upload:audio
```

脚本会生成 `config/audio-files.json`。该文件只包含 `cloud://` fileID，不包含密钥，可以提交到仓库。小程序启动时通过 `wx.cloud.getTempFileURL` 解析为可播放 URL。

## 健康检查

部署成功后：

- `GET /system/ping`
- 小程序真机通过 `wx.cloud.callContainer` 调用 `/auth/wechat`
- 管理面板：`/admin`

生产环境不要开启 `ALLOW_DEV_OPENID`。如果核心服务只由小程序调用，测试完成后建议关闭云托管公网访问；需要浏览器查看 `/admin` 时再临时打开公网，或后续把管理面板拆成单独的受控管理服务。

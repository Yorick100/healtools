# 康䇿工具箱 HEALTOOLS CloudRun v0.4.3

v0.4.3 是微信云托管稳定后端。小程序通过 `wx.cloud.callContainer` 调用本服务；MySQL 保存用户、推荐卡、五类工具记录、星星和同步事实；公共音频从微信云托管对象存储读取；CloudBase AI+ 只做有限 intent 理解。

## v0.4.3 重点

- 保留 `hy3 + reasoning_effort:none` 的低延迟 AI intent 路由，超时自动降级到确定性规则。
- `POST /ai/recommend` 新增 `replan` 语义。重新规划时会排除当前轮 action，尽量给出不同白名单卡片。
- 有部分已完成卡时继续保留完成卡，只替换未完成卡；当前轮全部完成后再次规划，会开启新的 `plan_id` 和新的 card_no。
- 新轮 card_no 在同一健康日内不复用，因此额外完成的新卡可以继续安全加星；同一 card_no 仍通过 `award_key` 保证幂等，不重复发星。
- 今日星星可超过初始推荐张数；客户端将“今天星星”和“本轮完成 X/N”分开展示。
- 最近 7 天睡眠/饮食记录继续作为弱排序信号；历史不会覆盖用户此刻明确表达的状态。
- `GET /daily-insight` 继续返回前一天睡眠/饮食的非医疗化生活方式提示。
- `/system/ping` 版本为 `0.4.3`。

## 必需环境变量

```text
HEALTOOLS_AI_ENABLED=1
CLOUDBASE_AI_ENV_ID=<CloudBase AI 环境 ID>
CLOUDBASE_AI_API_KEY=<服务端 API Key>
CLOUDBASE_AI_MODEL=hy3
CLOUDBASE_AI_TIMEOUT_MS=7000
HEALTOOLS_AUDIO_BASE_URL=https://...tcb.qcloud.la/healtools/audio/v0.4.0/
```

生产环境保持 `ALLOW_DEV_OPENID=0`。真实数据库密码、AI API Key、管理员密码不得提交 Git。

## 健康检查

- `GET /system/ping`
- `POST /ai/recommend`
- 第二次 `POST /ai/recommend` 携带 `replan:true`，确认 action 与当前轮不同
- 完成整轮后再次规划，确认新 card_no 可继续加星
- `GET /daily-insight`

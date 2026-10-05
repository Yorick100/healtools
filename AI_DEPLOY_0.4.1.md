# HEALTOOLS CloudRun v0.4.1 — CloudBase AI+ 接入补丁

## 目的

- 微信云托管继续负责：Express、微信身份、MySQL、对象存储音频。
- CloudBase AI+ 单独创建 AI 环境。
- AI 通过 CloudBase 官方 OpenAI-compatible HTTP API 调用，不再依赖 CAM SecretId/SecretKey。
- AI 只做有限 intent 识别；动作仍由 HEALTOOLS Safe Action Router 白名单决定。
- `/data-export` 与 AI 环境解耦：没有配置 `CLOUDBASE_EXPORT_ENV_ID` 时直接返回 JSON。

## 必填环境变量

```text
CLOUDBASE_AI_ENV_ID=<CloudBase AI 环境 ID>
CLOUDBASE_AI_API_KEY=<CloudBase 环境的服务端 API Key>
CLOUDBASE_AI_MODEL=hy3
CLOUDBASE_AI_TIMEOUT_MS=12000
HEALTOOLS_AI_ENABLED=1
```

音频继续：

```text
HEALTOOLS_AUDIO_BASE_URL=https://7072-prod-d3g9016l9d91b1c0a-1499218047.tcb.qcloud.la/healtools/audio/v0.4.0/
```

## 验证

1. `GET /system/ping`
   - `version = 0.4.1`
   - `ai_enabled = true`
   - `ai_provider = cloudbase_http`
2. `POST /ai/recommend`，使用不含固定关键词的自然表达。
3. 成功时：`provider = cloudbase_ai`, `fallback = false`。
4. 失败时：自动回退 `deterministic_v040`，并在云托管日志打印不含密钥和用户原文的错误摘要。


## Hotfix 1 (2026-10-06)
- 修复 `/system/ping` 中未限定调用 `aiConfigured()` 导致的 500。
- AI 配置缺失时输出不含密钥的诊断日志。
- AI intent JSON 解析更稳健。
- 默认 AI 超时改为 12 秒；生产环境建议 `CLOUDBASE_AI_TIMEOUT_MS=12000`。

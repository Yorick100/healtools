# 康䇿工具箱 HEALTOOLS CloudRun v0.4.4

v0.4.4 延续微信云托管 + MySQL + CloudBase AI+ 架构。

本版服务端仅扩展用户自己的 `/history` 响应：增加工具记录的 `started_at` 与 `payload_json`，供“记录”页展示呼吸/冥想时长、睡眠、情绪、饮食等详细历史。接口仍经过微信用户身份校验，不改变数据库结构。

`GET /system/ping` 版本为 `0.4.4`。

# Quantumult X Streaming Check

现代化的 Quantumult X 流媒体与 AI 服务可用性检测脚本。

## 检测项目

- 国际流媒体：Netflix、Disney+、YouTube Premium、Prime Video、Max、Discovery+、Paramount+、Peacock、DAZN
- 英国流媒体：BBC iPlayer、ITVX、Channel 4
- AI 与社交：ChatGPT、Claude、Copilot、TikTok

## 特点

- 等待全部检测任务，每项独立超时，主流程只结束一次
- 区分支持、受限、不支持、被封锁、异常、超时、无法确认
- JSON 安全解析，接口变化不会导致整体挂起
- 自动根据 ISO 地区代码生成旗帜
- 无法确认时不会误报为“不支持”
- Peacock 仅依据 HTTP 状态及重定向目标判定，避免正常首页中的 `unavailable` 组件名称造成假阴性

> 结果来自无需登录的公开页面或接口，只代表检测时当前节点对相应公开端点的可用性，不等同于账号、订阅、DRM 或实际播放的绝对保证。

## Quantumult X

在 `[task_local]` 中添加：

```ini
event-interaction https://raw.githubusercontent.com/gonepaul/QuantumultX-Streaming-Check/main/streaming-ui-check.js, tag=流媒体与AI解锁检测, img-url=checkmark.seal.system, enabled=true
```

## 参考项目

- [HsukqiLee/MediaUnlockTest](https://github.com/HsukqiLee/MediaUnlockTest)
- [lmc999/RegionRestrictionCheck](https://github.com/lmc999/RegionRestrictionCheck)

本项目的 Quantumult X JavaScript 实现为独立重写。

## License

MIT

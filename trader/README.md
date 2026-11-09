# 带单员与公开账户研究

本站在 GitHub Pages 展示公开账户表现，公开快照位于 `trader/feed.json`。个人手工记录仍仅保存在当前浏览器；页面没有文件导入或导出入口。

## 已接入来源与范围

Hyperliquid 官方网页使用 `https://stats-data.hyperliquid.xyz/Mainnet/leaderboard` 获取公开账户列表。首次验证收到 48,229 个账户的有效 JSON；上线快照选取来源月度盈亏最高的 200 个账户。筛选、排序只作用于这 200 个账户，不代表完整交易所名单、认证带单员或投资推荐。名单可能包括普通钱包、金库及其他账户；展示名由账户自行设置，不是实名或身份认证。

- 周度、月度、累计的 ROI 和 PnL 直接采用来源对应 `week` / `month` / `allTime` 字段。ROI 小数乘 100 显示为百分比，金额口径为来源 USD。
- `7D` / `30D` 是本站兼容键；页面将这类源端窗口显示为“周度（来源）”和“月度（来源）”，不擅自承诺精确起止时刻。
- 账户权益直接采用 `accountValue`；零值不被视为缺失。
- 最大回撤、逐笔胜率、交易记录和收益曲线没有充分输入，保持空值。不会用累计 PnL、钱包余额变化或盈利日比例代替。
- `fetchedAt` 是采集时间；`snapshotAt` 是 HTTP Last-Modified 表示的来源文件时间，不是每个账户自身最后成交或更新时刻。

## 更新与失败处理

`.github/workflows/refresh-traders.yml` 计划每 30 分钟执行采集，并显式发布完整 Pages artifact。GitHub 定时运行可能延迟，来源自身也可能晚于采集时间；这不是实时成交行情。

页面可见时每分钟检查本站小型快照，隐藏时暂停。采集失败保留上次通过校验的数据，并标记过期；超过 120 分钟也由前端独立判断时效，避免定时任务停止后仍显示“最新”。失败首次没有历史快照则展示不可用，不制造记录。

采集器只发一次有大小与时间限制的 HTTPS GET，不使用密钥、代理池、客户端伪装或绕过限制；对拦截、限流、非 JSON、异常结构均保守处理。39 MB 的原始来源文件仅用于云端核验，不发布进仓库或网页。公开文件仅包含选中账户的必要字段。

## 其他来源

OKX 当前云端返回 Cloudflare Error 1010 / HTTP 403，已停止尝试；Bybit 已核验端点返回 Site Unavailable HTML，尚无可展示的有效数据。它们不作为本次发布的采集依赖。`okx-import.js` 是网页未加载的离线开发模块，不代表已接通。

## 来源证据

- [Hyperliquid 官方排行榜](https://app.hyperliquid.xyz/leaderboard)
- [官方 API 文档](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)
- [账户曲线口径](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/portfolio-graphs)
- [限流](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits)
- [Terms](https://app.hyperliquid.xyz/terms)

2026-11-09 核验官方前端 `Leaderboard-D06I9MTf.js` 和 `config-BOv79UVk.js` 的请求路径及字段映射，并阅读 Terms（页面标注 2026-06-15 更新）。未发现一般性公开账户展示禁令，也未将 SDK 的 MIT 软件许可误作数据许可。实现不绕过访问限制或限流，不暗示官方合作。

合成测试仅在测试进程中运行，不写入生产快照。

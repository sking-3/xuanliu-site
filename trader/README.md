# 带单员与公开账户研究

本站在 GitHub Pages 展示公开账户表现，公开快照位于 `trader/feed.json`。个人手工记录仍仅保存在当前浏览器；页面没有文件导入或导出入口。

## 已接入来源与范围

Hyperliquid 官方网页使用 `https://stats-data.hyperliquid.xyz/Mainnet/leaderboard` 获取公开账户列表。首次验证收到 48,229 个账户的有效 JSON；每次采集先选取来源月度盈亏最高的最多 200 个候选，再逐一核验默认永续 DEX 的持仓。公开列表仅保留成功读取到非零持仓的账户；空仓、请求失败及未核验账户不列入，也不向更低排名补足 200 个。筛选、排序只作用于本次核验后保留的账户，不代表完整交易所名单、认证带单员或投资推荐。名单可能包括普通钱包、金库及其他账户；展示名由账户自行设置，不是实名或身份认证。

- 周度、月度、累计的 ROI 和 PnL 直接采用来源对应 `week` / `month` / `allTime` 字段。ROI 小数乘 100 显示为百分比，金额口径为来源 USD。
- `7D` / `30D` 是本站兼容键；页面将这类源端窗口显示为“周度（来源）”和“月度（来源）”，不擅自承诺精确起止时刻。
- 账户权益直接采用 `accountValue`；零值不被视为缺失。
- 快照中的回撤、胜率、曲线仍保持空值；浏览器按需向官方 Info API 取得计算输入，详见下文。没有充分输入的指标保持空值，不用示例值填补。
- `fetchedAt` 是采集时间；`snapshotAt` 是 HTTP Last-Modified 表示的来源文件时间，不是每个账户自身最后成交或更新时刻。

## 更新与失败处理

`.github/workflows/refresh-traders.yml` 计划每 30 分钟执行采集，并显式发布完整 Pages artifact。GitHub 定时运行可能延迟，来源自身也可能晚于采集时间；这不是实时成交行情。

页面可见时每分钟检查本站小型快照，隐藏时暂停。采集失败保留上次通过持仓资格校验的数据及原时间，并标记过期。持仓资格超过 60 分钟后，前端独立隐藏该账户，避免定时任务停止后仍将其列为持仓账户；旧版未核验名单也不会继续展示。持仓资格只代表核验时刻，不保证此后没有平仓。详情页成功读到更新的空仓状态时立即从列表移除；读取失败不冒充空仓。失败首次没有已核验快照则展示不可用，不制造记录。

采集器先发一次有大小与时间限制的 HTTPS GET，再对最多 200 个候选各发一次只读 `clearinghouseState` POST。持仓请求最多并发 4 个、每秒启动 2 个、单次最多 10 秒、整批最多 240 秒。403/429 立即停止整批，不自动重试；非 JSON、异常结构、过旧持仓时间均视为核验失败。持仓核验时间与榜单文件时间分别保留。成功但无仓位与请求失败分别计数。不使用密钥、代理池、客户端伪装或绕过限制。39 MB 的原始来源文件仅用于云端核验，不发布进仓库或网页。公开文件仅包含选中账户的必要字段。

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

## 按需持仓、挂单与成交

公开 Hyperliquid 账户详情新增“实时交易”视图。只有打开该视图才向官方 `https://api.hyperliquid.xyz/info` 请求 `clearinghouseState`、`frontendOpenOrders` 和 `userFills`，并连接 `wss://api.hyperliquid.xyz/ws` 订阅该地址的 `userFills` 与 `orderUpdates`。公开名单加载不会为200个账户同时建立连接；个人手工记录不会被自动发送到来源。

持仓、挂单是 REST 状态快照，页面打开期间约每60秒核对一次；成交和订单事件通过 WebSocket 接收。实时流不可用但 REST 可读时，最近成交退回每60秒快照查询，页面明确显示降级状态。首次 `isSnapshot` 是此前成交记录，不能当作新开仓。A表示卖、B表示买，开仓/平仓直接采用来源 `dir`；成交金额为价格乘数量的名义金额，不是保证金。手续费保留来源币种，负数可能是返佣。现货代码通过官方 `spotMeta` 解析，缺少映射时显示原始代码，不猜报价币。

REST 成交接口最多返回最近2000笔，本页面保留最近200笔用于阅读，不宣称完整历史。记录按成交标识去重，不用短暂静默判断订单全部成交。当前永续持仓仅覆盖默认永续DEX，挂单覆盖默认DEX及其返回的现货订单；其他DEX覆盖不被暗示为完整。

关闭详情、切换标签/账户或隐藏页面时停止连接；返回页面后重新读取状态。错误/断开会在详情中显示，旧数据与读取时间保留。本功能不在关闭页面后继续监听，不是全天后台档案，也不含任何下单、授权、签名或交易密钥。

来源文档：
- [REST Info](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)
- [WebSocket 订阅及消息格式](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions)
- [订阅限制](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits)
- [现货品种元数据](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot)


## 卡片曲线与风险指标

`account-analytics.js` 是只读、浏览器内的按需分析模块。仅为当前页可见的最多 12 张公开账户卡片读取 `portfolio`，翻页会取消不再需要的请求。结果仅内存缓存 5 分钟，不写浏览器存储或生产快照。胜率须点击单个账户的计算入口才读取最近 `userFills`。分析队列最多并发 2 个，滚动一分钟最多使用 400 请求权重；隐藏页面、关闭模块会取消排队及请求。403/429 后停止自动读取，手动重试需显式操作。分析结果与榜单 ROI/PnL 的采样时间分开，不改写来源发布的收益率。

- **曲线**：使用来源 `week/month/allTime` 的真实 `pnlHistory` 点，以窗口首点为零基准。必要时只从原始样本选点，不虚构中间波动、不用账户余额变化代替盈亏。回撤先用完整原始样本计算，再为迷你图选点。
- **来源采样回撤**：核验官方前端计算后采用 `max((历史累计盈亏峰值－当前累计盈亏)/峰值时账户权益) × 100%`。累计盈亏创新高或持平时更新该峰值时的权益分母。要求盈亏与权益数组逐点时间相同、数值有限且分母有效。来源样本不足则留空。它是来源采样口径，可能超过 100%，并非完整盘中或资金流调整后策略净值回撤；不除以累计盈利峰值，不擅自截断到 100%。
- **平仓成交胜率**：从最近最多 2000 条成交中，筛选默认永续、USDC 手续费、合法方向和数量的 `Close Long/Close Short` 成交；`closedPnl - fee > 0` 的笔数除以全部有效平仓成交。零毛盈利扣费后亏损也计入；净盈亏为零保留在分母。负手续费返佣按原符号处理。反手、现货及其他 DEX 不混入。
- 胜率展示实际样本起止时间与笔数，独立于卡片所选收益窗口。分笔成交分别计数，只扣本次平仓手续费，未分摊开仓手续费和资金费；因此不是完整交易轮回胜率，也不承诺覆盖整月或累计历史。零有效样本则留空。

卡片使用“万／亿”压缩大额数字，完整数值通过提示及详情保留。绿表示盈利、红表示亏损。没有交易密钥、交易权限或自动跟单行为。

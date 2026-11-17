# A 股成交活跃：首页与数据合同

目标链路是 GitHub Actions 云端更新名单，首页读取本站静态 JSON，点击股票打开本站 chart.html 的 TradingView 图表。用户 Mac 不参与执行。本草稿完成展示、五日均额排序与离线回归；未实现或启用真实来源的每日自动发布。

## 当前提交的生产状态

research-data/a-active-stocks.json 仅含 not_configured、空 rows、空交易日及 null 日期/来源。首页显示“待接入”。没有将测试股票、价格或成交额写入生产快照；现有观察列表和涨跌榜保留，均不冒称热门榜。

audit/active-stocks-fixture.cjs 中的三只证券全部是合成数值、合成名称。只有 Node 测试和拦截响应的浏览器测试加载它；浏览器明确显示“合成测试数据 · 非真实行情”。发布脚本从 git archive 中移除整个 audit 目录。前端没有测试模式 URL、fixture 引用、浏览器缓存回退或真实行情源请求。

## 展示与计算

- 指标为五个完整交易日的成交额算术平均，单位 CNY；缺少任何一天、单位不明、字符串数字、负数、非有限数值、日期错位或证券重复，整个快照拒绝展示。
- 目前只接受 supplied_stock_sample。页面同时说明所提供样本数、完整数据数和排除数，最多显示十只；不宣称全市场排名，不把成交活跃称搜索/社交关注热度。
- 完整且真实的零成交日允许参与平均；五日均额为零的证券不进入活跃榜。缺失不能补零。均额相同时按交易所证券代码排序。
- 日期始终取 dataAsOf，必须等于五个输入交易日的末日。generatedAt 不早于末日上海 15:00，也不得晚于读取时刻；超过末日收盘 72 小时显示“历史快照”。72 小时仅是保守的展示提示，不能判断节假日后的应更新交易日。
- 输入生产者必须使用获准交易所日历验证最近五个完整交易日及每只证券的最终日记录。前端只验证日期顺序、工作日、闭市时间和 completedSessionsVerified 标记，不能独立证明节假日、交易日连续性、停牌记录或源数据完整性。
- SH 主板/科创板和 SZ 主板/创业板代码映射 SSE:/SZSE:，点击 chart.html?tvwidgetsymbol=...；北京市场和未知号段拒绝。代码语法符合不等于每只股票在 TradingView 可用，实际显示仍以来源为准。
- 图表沿用 TradingView 的自有日终行情；本模块不把 TDX/腾讯成交额或价格注入 Widget。图表连接失败时，现有页面提示来源未响应并保留恢复入口。
- 初次读取失败无排名；刷新失败保留已验证快照和原始来源日期，并标“更新失败 · 保留…快照”。不会将检查时间当作行情时间。显式 not_configured 会清除旧名单，随后失败也不恢复它。本站 JSON 每轮单次请求，redirect:error、credentials:omit、10 秒超时。

## 待云端生产者满足的字段

ready 快照需要 schemaVersion=1、synthetic=false、method=mean_daily_turnover_5_sessions、amountUnit=CNY、completedSessionsVerified=true、dataAsOf、UTC generatedAt、五个 tradingDates；source 含 id/name/publicDisplayApproved/permissionReference；coverage 含 scope/supplied/complete/excluded；rows 每只含 exchange/code/name 和五条 date/amount 的 dailyAmounts。

publicDisplayApproved 和 permissionReference 只是可审查的元数据，不构成授权，也不能解锁采集器。completedSessionsVerified 同样不是独立验证。真实云端生产者尚未接入，必须先完成 SOURCE_ACCESS.md 的共享停止状态、来源许可与真实数据验收。当前测试明确要求生产快照保持空态；以后接入真实数据需单独修改测试并复核，不可把 synthetic 改成 false 冒充真实。

本格式会公开用于计算的五日成交额，来源许可必须覆盖这些字段的缓存、派生排名及公开展示；如果许可只允许发布派生名单，需在接入前另行设计和审查更小的发布合同。

## 自动化验收

node --test audit/home-active-stocks-unit.cjs 检验计算、日期、单位、覆盖、映射和生产空态。既有 node scripts/verify_public_release.cjs 自动发现该测试，再分别用 Chromium/WebKit 运行 audit/active-stocks-browser.cjs。

浏览器覆盖 1440/768/390/375 宽度、合成数据醒目标记、两交易所各一次真实站内路由跳转、图表源不可用状态、恶意名称安全文本、读取 403、无效 JSON 和缺日拒绝。所有外部 HTTP/WebSocket 被拦截，service worker 禁用。通过这些测试不能证明真实行情源、每只证券 Widget 可用或公开展示授权。

## 云端上线仍需完成

1. 来源授权和公开展示范围；腾讯接口用法、mootdx MIT 文件或能连 TCP 均不能代替数据授权。TradingView Widget 沪深市场日终，且不是可导出给 Actions 排名的数据 API。
2. 旧来源拒绝/暂停状态完整映射到同一来源身份，并在不同临时 runner 之间持久继承。当前采集入口保持硬关闭。
3. 获准 runner 的真实股票目录、五个交易日、成交额单位及完整数据；空响应应持久停止，不能换服务器或客户端绕过。
4. 通过后再实现定时任务、原子发布、失败保留原 dataAsOf、两次跨日更新验收及撤销授权验证。本提交没有新增数据采集 schedule/dispatch。
5. 独立复核后才考虑合并/部署。普通 push 的受审阅来源 jobs 已隔离，但旧 schedule/dispatch/continuation/排队任务仍独立存在。发布前 main SHA 检查与部署之间也仍存在竞态；本提交没有证明整仓静默或消除该竞态。

## 2026-11-17 文档复核补充

[TradingView 市场表](https://www.tradingview.com/widget-docs/markets/asia-pacific/)列出 SSE/SZSE 为 EOD；[数据 FAQ](https://www.tradingview.com/widget-docs/faq/data/)明确 Widget 使用其自身数据，不能导出数据或注入自有数据。[Market Summary 官方介绍](https://www.tradingview.com/widget-docs/widgets/watchlists/market-summary/)提到自动展示当日涨跌标的，但此次可读取文档未给出足以验证“中国市场成交活跃预设”的配置和逐证券实测，因此不把它记为已验证替代方案。

另查了 [Tushare 数据服务协议](https://tushare.pro/document/1?doc_id=405)：使用服务第 5 项将标准服务限定为个人非商业查看。该标准许可不足以作为本站公开快照的授权依据；如有另行授权须单独核实。[BaoStock 知识库入口](https://www.baostock.com/mainContent?file=pythonAPI.md)此次未提供可读取的许可正文，不能根据免费/开源宣传推断公开再分发权利。未调用这些候选的行情 API。

这些只是文档核查结论，未替用户接受协议、申请账号、购买服务或联系供应商。云端实际数据和公开展示权限仍待取得证据。

## 长期开页与发布一致性修复

可见页面每 5 分钟读取本站 JSON，每 60 秒按当前时钟重算 72 小时历史提示；隐藏页暂停定时读取，visibilitychange 恢复和 BFCache pageshow(persisted) 立即重算并刷新。重复 mount 和并发触发复用同一请求；正常退出清理定时器、事件和请求。超时的晚返回、销毁后的旧实例、较旧 dataAsOf/generatedAt，以及相同生成时间被改写的内容不能覆盖已接受快照。当前同版本内容比较使用解析后 JSON 序列化结果，生产者应保持稳定字段顺序或使用新的 generatedAt。

计时刷新只访问本站名单文件，不调用腾讯/TDX 或其他行情 API，不解除采集器硬关闭。页面内保留的数据不写入浏览器持久缓存。

发布归档现在将 research-data/a-active-stocks.json 的 SHA-256 加入 assets，并记录 activeStocks 的 schemaVersion、method、status、dataAsOf、generatedAt 和 tradingDates。发布后校验要求当前候选提交、名单元数据、名单实际字节和 JS/CSS 字节全部匹配；名单缺失哈希、旧日期/版本或内容改动均拒绝验收。归档还拒绝 synthetic=true 的名单。

这些是发布完整性与前端格式验证，不是生产者授权或真实性校验。真实云端生产者仍未实现/启用；接入前必须验证来源许可、交易所日历的五个连续完整交易日、最终成交额单位和源记录，并在共享停止守卫之后生成快照。发布前检查与部署之间原有竞态仍未消除，本次不合并、不部署。

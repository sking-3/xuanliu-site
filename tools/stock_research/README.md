# 股票研究第一版

此目录是无网络、无交易能力的一次性数据处理程序。当前生产清单为 `not_configured`：没有连接行情账号，没有取得正式全市场日线、分钟行情或真实异动。页面每分钟读取本站发布文件，不等于每分钟采集交易所数据。没有新增后台排程。

## 已实现

- 收盘批次校验：交易日历、完整收盘时间、当日证券资格、复权、连续交易日日线、全市场数量与分页证据分别检查。异常输入在写出前失败，保留上一次文件。
- A股只接受沪深主板普通股、正常10%限幅；已证 ST、风险警示、退市、停牌排除，证据不齐待核。原 M1—M5 尚未定稿，不将研究分支冒充正式选股。
- 美股 U1 事件形态、U2 放量突破、U3 临近突破独立运行并合并。参数是可复核的研究默认值；U1 的公告催化另核，不保证收益。IEX 单交易所成交量不作为全市场 SIP 口径。
- 异动使用同市场时段、同分钟的至少10个历史交易日成交额中位数。最近最多20日，放量3倍为观察，另有绝对1分钟涨跌至少1%才标量价确认；来源超过120秒不产生新事件。记录来源、接收与发现时间并去重。这不是机构真实资金流。
- 来源停止或失败保留历史并标旧；未经确认可公开展示的数据不输出价格。未知供应商字段不会直接序列化。
- 页面提供策略筛选、候选详情、站内K线、自选添加/移除与本浏览器保存。盘中行情尚未接入时显示等待，不生成价格。原文件复核功能在折叠区保留。

## 一次性运行

在仓库根目录执行：

```sh
python3 -B -m unittest tools.stock_research.test_engine -v
node --test audit/stock-workspace-unit.cjs
python3 -B -m tools.stock_research.pipeline --input /path/to/authorized-batch.json --previous research-data/snapshot.json --output /path/to/review/snapshot.json
```

先在仓库外核对结果与授权，再按已批准的发布流程替换 `research-data/snapshot.json`。不要将原始下载、凭证、个人自选或测试行情提交到生产清单。程序没有定时、交易所访问、HTTP重试或下单代码。公开结果上限8MB，超出会停止写出；需要分片后才能扩大输出。

输入 `schema` 为 `books.stock.input.v1`，`markets` 按 `a`、`us` 分开。每个批次需要：

| 字段 | 所需证据 |
| --- | --- |
| `market` | 与所在市场键一致 |
| `session` | `date`、带时区的真实 `closeTime`、`calendarVerified`、至少61个连续交易日 `tradingDates`（含当日） |
| `source` | `id/name`、`receivedAt`、同日 `dataAsOf`、`coverage`、`expectedCount`、`paginationComplete`、`permissionsVerified`、`redistributionAllowed`；美股另需 `feed=sip` |
| `securities[]` | `symbol/name`、当日 `eligibility`、`adjustmentVerified`、至少61根 `bars` |
| `eligibility` | `asOf`、`exchange`、`assetType`、退市/停牌状态；A股另需主板、ST/风险标识、已核实10%限幅 |
| `bars[]` | 日期、OHLC、股数单位 `volume`、原币成交额 `turnover`；复权必须沿用已核实的统一口径 |
| `benchmark[]` | 同交易日的SPY收盘价；缺失不通过U2/U3相对强度条件 |
| `observations[]` | 市场/代码、交易所当地日期/分钟与时段、带时区 `sourceTime/receivedAt`、来源标识、价格/分钟成交额/币种/一分钟涨跌及同刻历史 `baseline` |

来源 `stopped=true` 或 `errorCode` 只保留已有结果，不尝试别的入口。403/429及权限限制必须在上游永久停止对应来源，不得换客户端、域名或代理重试。

## 数据适配范围与尚缺项

`adapters.py` 只规范化已合法取得的供应商响应导出；未联网验收真实账户。Tushare表格适配将手换成股、千元换成元，复权因子相对本批最新日归一化；不自动证明因子或资格正确。Alpaca适配要求分页到底、不重复，成交额采用供应商VWAP乘股数的派生口径。交易日历、证券资格和使用/公开展示权限须由上游实际核验。

官方依据：[Tushare日线与单位](https://tushare.pro/document/2?doc_id=27)、[Tushare响应结构](https://tushare.pro/document/1?doc_id=130)、[Alpaca历史Bars分页](https://docs.alpaca.markets/us/reference/stockbars)、[IEX/SIP覆盖差异](https://docs.alpaca.markets/us/docs/market-data-faq)。这些链接不构成数据授权。

后续需要接入经授权的数据源并完成真实批次对账，再验证盘中推送、端到端延迟、失败停止及通知。当前没有这些账号权限，因此未声称“自动全市场已运行”或“第一时间看到机构资金”。

## 次日研究与两项独立验收（2026-11-14）

`research-data/strategy-design.json` 为六个独立研究假设的版本化设计，A-R / US-R 不替换原 M1—M5、U1—U3。方案尚未启用，数字只是研究初值；不存在已验证的方向概率或真实样本外成绩。正式选股池必须来自完整证券目录和已核验批次，观察样本不代表全市场。

`next_session.py` 只做无网络、无交易的方向核对：`evaluate_direction(signal, outcome, now)` 分别给出昨收至次收、次日开盘至收盘和隔夜跳空。信号要求 `strategyVersion`；同策略不同版本不混算。时间声明只用于校验顺序，不能证明事前真实发布；晚发布标 `historical_replay`，未定数据不填数字。`priceBasis` 必须涵盖同一复权锚点和公司行动口径，不能只写笼统的“复权”。

`summarize_direction()` 按市场、策略版本与时间证据类别分别统计命中、未定、观察及真实不同交易日数，不输出虚构胜率。前晚方向分母保留全部冻结信号，不能只挑次日触发者。日线不能证明触发与失效的先后，不据此认定成交；A股次日新买仓位不能同日卖出。可执行机会与方向另账，模拟收益还须另外验证成本和成交。

```sh
python3 -B -m unittest tools.stock_research.test_engine tools.stock_research.test_next_session tools.stock_research.test_entry_plan -v
```

`entry_plan.py` 独立核对冻结后的做多触发价、失效价和最高可接受价格，区分未触发、先失效、开盘超出范围、触价但报价未核验、已观察到报价机会与证据待核。必须具备从开盘开始的连续有序证据、同一实际报价单位和复权锚点，以及新鲜买卖报价、停牌与限价状态；仅有分钟OHLC不推断先后。报价机会不等于真实成交，不计算交易收益。其统计不与方向命中混算，也没有连接生产账本或自动运行。

本轮还修复收盘日期/来源接收时间校验、矛盾重复基准和失败时私人缓存误进入公开输出的路径。来源失败仍保留合法公开历史；不可信批次待核，不输出当天形态或价格。新增规则设计和离线验证器并不表示生产选股、盘中雷达或新后台排程已启用。

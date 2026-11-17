# 云端名单与静态发布：当前审查方案

本方案仅供草稿复核；未合并、未部署、未 dispatch 采集，也未修改旧停止记录。目标是在 GitHub Actions 云端自动生成名单、更新现有首页，再以证券代码打开站内 TradingView 图表。用户 Mac 和用户日常手动运行不属于交付前提。

## 已确认的发布风险与候选修复

审阅基线：main 64ecf3624de4703756f913381a33c3edb85a9b70。

原 refresh-traders.yml 监听 main 的绝大多数 push。resolve_trader_refresh_mode.cjs 将普通提交解析为 full；因此“新 mootdx 自己关闭”不能阻止一次普通合并启动 Aoying、Binance、Hyperliquid 等旧采集链路及来源检查。原 [ui-only] 路径虽会跳过这些步骤，但要求提交信息正确，不应作为唯一保护。

候选分支加入以下工作流级条件。这些条件先于整个来源 job，包括 checkout、SDK、检查点/队列检查和网络步骤；不依赖变更路径或提交标记。

| 工作流 / job | 代码 push 和 PR | 保留的其他触发范围 |
| --- | --- | --- |
| refresh-traders / collect-build | 拒绝整个采集 job，其 deploy 因依赖未成功也不运行 | 原 schedule、workflow_dispatch |
| binance-public-orders / watch | 仅执行离线 test，watch 拒绝 | 原 main 上的 workflow_dispatch；原 ticket 和来源守卫仍须通过 |
| refresh-aoying / collect | 拒绝来自 push/PR 测试完成的 workflow_run 链 | 原手动 dispatch，或 main 上由 workflow_dispatch 启动且成功的 public-orders 完成事件 |
| refresh-macro-cn / refresh | 拒绝 | 原 main 上的 schedule、workflow_dispatch |
| quant-research / research | 只保留 validate，research 拒绝 | 原 main 上的 schedule、workflow_dispatch |

这会改变旧的“改采集脚本后自动采集”行为：今后代码 push 只验证和发布，实际采集需要独立调度/dispatch，并继续遵守原来源限制。条件允许某事件不等于来源已获授权，本次没有运行这些事件。

deploy-static-pages 保留静态发布：push checkout 固定为 github.event.after；普通手动/复用调用的旧行为未改变。原门禁继续要求干净的已提交文件、离线测试、当前 main 与待发布 SHA 一致，随后部署和核对静态资源。检查时若 main 已推进则拒绝，但检查与部署之间仍有竞态，不能据此保证部署瞬间 main 未变化；后验不符必须如实报告。本轮未解决该竞态。

## 不访问行情源的候选发布步骤

1. 继续保持 PR 草稿。独立复核本 PR 的完整差异，必须包含上述五处来源 job 限制和静态 push checkout 固定；不能只挑选 mootdx 工具文件后普通合并。
2. 在最终候选提交上运行下列离线检查。test_release_plan.cjs 只读文件，核对已审阅工作流、发布脚本及浏览器测试的 Git blob 指纹，并解释受限布尔表达式；不执行工作流、采集器、队列查询或停止记录读写。出现新 workflow/job、未知表达式或版本漂移即失败，必须重新审阅。
3. 确认最新候选的 CI 成功且与将要合并的内容一致。合并是后续单独执行的发布动作，本轮不执行。无需依赖 [ui-only]；不能使用 [skip ci] 绕过验证。
4. 合并后由该 push 的静态发布工作流检查、暂存和部署那个事件的确切 SHA。来源 jobs 在 push 上拒绝；public-orders 的测试完成也不能再经 workflow_run 启动 Aoying。
5. 后验只使用已审阅的静态校验脚本：release-manifest.json 的 revision 和关键资源哈希须一致。浏览器检查拦截所有外部 HTTP、WebSocket，并禁用 service worker；仅放行本站资源或本地测试服务。不要用普通无拦截浏览器点击行情按钮来完成本次验收。
6. 若 SHA 不符、main 前进、检查失败或发布目标返回拒绝，停止发布验收，保留证据和旧站。不要切到 refresh-traders 的 full/positions 手动运行来“修复部署”，不要改旧停止记录或查询曾被拒的 Actions 排队接口。

离线命令（均不会生成真实行情）：

```bash
node --test tools/mootdx_feed/test_release_plan.cjs
python -B -m unittest tools.mootdx_feed.test_collector -v
node scripts/verify_public_release.cjs
```

最后一条使用既有 Playwright/lxml 测试环境；依赖准备按仓库 setup-public-release action。GitHub/npm/PyPI 和浏览器包安装流量不属于行情采集，不能将整个 CI 称为完全无网络。

发布归档由 git archive 生成，只包含已提交文件。当前 staging 规则会带上公开的 Python 源码和文档，但 GitHub Pages 不执行它们；私人 HOME 下的停止记录和样本输出不在归档中。新增首页成交活跃组件和生产空态 JSON；合成数据仅在被归档排除的 audit 目录内。没有真实榜单或新行情日期，不把新 release SHA 当作行情日期。具体字段、显示与验证见 HOMEPAGE.md。

## 整仓静默的边界

本方案证明的是**代码发布事件不会进入受审阅的采集链路**，不是整仓所有任务已停。既有 schedule、手动 dispatch、public-orders continuation 及旧 A 股手动入口仍是独立入口；当前没有取消、停用或重试它们，也没有通过受限队列查询确认“没有任务运行”。

如果验收要求发布窗口内整个仓库完全不访问任何受限来源，仍需要总负责人另行安排合法的全局关闭/静默措施并核实旧入口。新 mootdx 的硬关闭和本次 push 隔离不能代替这项核查。旧状态整合依照 SOURCE_ACCESS.md，未完成前不能启用新云端采集。

## GitHub 自动更新名单的后续实现合同

本次发布隔离并不等于自动名单已实现。2026-11-17 的文档核查结论：

| 候选 | 可确认部分 | 尚未通过 |
| --- | --- | --- |
| mootdx / 通达信 | 固定依赖可在 GitHub Linux runner 安装并完成离线解析测试；已有相同版本空响应报告 | 云端真实行情、源授权、公开展示权利、旧停止状态共享；当前入口硬关闭 |
| 腾讯公开行情入口 | 既有代码和社区资料中有接口用法 | 尚未取得明确覆盖本网站自动采集、缓存及公开展示的官方授权依据；社区文章不能替代；未为本次核查发行情请求 |
| TradingView Widget | [官方市场表](https://www.tradingview.com/widget-docs/markets/asia-pacific/)标明沪深为日终；[数据 FAQ](https://www.tradingview.com/widget-docs/faq/data/)说明 Widget 数据能力边界 | 可作为站内图表展示层，不能据此认定可导出数据给 Actions 生成榜单，也不能注入腾讯/TDX 报价 |

因此目前还没有被本项目验收、同时满足云端输入内容和公开展示权限的名单来源；这不是断言不存在可用服务。不得为满足自动化目标而假设许可、恢复旧被拒源或从 Widget 抽取数据。

后续云端链路必须按以下顺序实施：

1. **来源准入和持久状态**：核实云端来源、具体访问与公开展示范围；将所有旧拒绝/暂停证据纳入同一来源身份。跨 Actions runner 的锁、拒绝记录和授权撤销必须持久化并先于任何请求检查。当前 HOME 下的独立锁不能跨临时 runner 继承，不能直接用于生产自动任务；状态缺失或恢复不明一律拒绝。
2. **真实输入**：仅在获准来源上验证名单所需的股票目录、行情日期、成交额单位和完整交易日覆盖。TCP 可连接、能返回股票列表、包可安装或 CI 成功都不是行情验收。mootdx 当前保持硬关闭；不以新客户端、域名轮换或新 runner 绕过旧停止。
3. **榜单口径**：优先研究“最近五个完整交易日日均成交额”，展示名为成交活跃，不称搜索热度。只有已核实的同一五个交易日完整数据才参与；不补造缺日、不用 OHLC 估算成交额、不把输入样本称为全市场。
4. **输出与页面**：生成有 schema、sourceId、真实 dataAsOf、tradingDates、coverage、method 和状态的榜单 JSON；验证通过后原子更新。首页展示来源和数据日期，失败保留旧日期并标旧。沪深代码映射至 SSE:/SZSE:，点击在站内显示 TradingView 自有行情图表；腾讯/TDX 数据不注入 Widget，A 股 Widget 的日终时效须明确。
5. **调度与验收**：共享状态、权限、数据内容和页面均通过后，才提交并复核 GitHub Actions 定时工作流。证明两次独立 runner 能继承停止状态、拒绝不重试、失败不发布、真实名单跨日更新且网站读取同一 SHA/数据日期，然后才可称云端自动更新已上线。

不以用户 Mac 为执行环境，也不把用户每天手动运行作为最终方案；旧停止状态的交接仍是权限核查材料，不能因为改为云端就忽略。

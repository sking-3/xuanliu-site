# 通达信来源准入与旧停止状态整合

## 当前结论

44f55e6 的本地停止机制只覆盖新 mootdx_feed 入口。2026-11-17 只读核查没有在可访问仓库中找到实际 TDX 拒绝事件记录；这不证明其他机器或旧运行中不存在记录。此前所称旧状态尚未取得准确路径、格式及事件证据，不得写成已经核实存在的 TDX 停止事件。空的新目录不能证明来源未被拒绝，用户允许上传采集代码也不等于数据源允许访问或允许公开再展示。

本次补丁只完成**可验证的关闭措施**：读取仓库既有共享 source-holds 政策，并在旧来源迁移未完成时无条件拒绝真实采集。没有复制、重命名、删除或生成任何实际旧来源记录，没有修改共享授权或启用工作流。README 中的生产采集示例已撤下。

## 已核对的仓库事实

- 基线 main 为 64ecf3624de4703756f913381a33c3edb85a9b70。
- scripts/source-holds.json 现有键属于 Binance 或 GitHub 操作，没有通达信准入授权。其余来源的 approved 项不能跨来源使用。
- tools/binance_watch/source_holds.py 提供现成的共享政策读取函数：缺失键、读取异常、JSON 异常或非 approved 值一律拒绝。本入口复用该函数；预留 aShareTdxCollector 键，但不写入授权。
- main 的 tools/stock_research/a_share_sources.py、scripts/collect_a_share.py 仍是旧适配器，没有接入该共享守卫；旧 mootdx 工厂仍有默认扫描与回退路径。尚未定位历史 TDX 停止事件所在机器、路径和格式，不能猜测或生成替代记录。
- source-state.json 仍保留在新入口自己的命名空间，仅用于附加防护；本补丁不声称它已经成为共享来源守卫。

## 完成整合前需要的交接材料

总负责人提供最新旧守卫代码或准确的提交/补丁，以及部署采用的以下合同即可；无需账号密码、密钥或行情原文：

1. 所有旧来源记录的固定路径与格式版本，文件缺失是否代表“从未迁移”。
2. 来源标识、客户端/端点别名映射和操作范围。应按真实上游来源归并，不能按 mootdx、旧客户端或不同 IP 分出可绕开的权限。
3. 哪些拒绝/暂停状态是持久的，哪里保存权限撤销及恢复依据；是否存在自定义 HOME、输出目录、环境变量或另一个机器上的旧记录。
4. 旧入口使用的锁及原子写入协议、所有可能产生真实网络请求的入口清单。
5. 实际允许访问的来源与端点、操作、标的范围、频率限制和到期条件，以及对应可核验授权依据。代码仓库的 approved 字符串不代替这项核验。

缺任何一项，保持本次关闭措施；不要用空白迁移清单、猜测路径、CLI 勾选框或新记录替代旧证据。

## 计划中的共享检查顺序（尚未实现/验收）

1. 停止所有新旧调度及入口的真实访问，在隔离环境确认完整入口和来源别名清单。
2. 在同一来源的共同锁内，只读核对所有旧记录、新记录和来源授权。任一停止/撤销/损坏/不可读/映射不明都拒绝；新授权不得自动抹去旧停止。没有完整清单不能把“未发现”解释为允许。
3. 将已有停止证据保留原位；如需迁移，只能向共享记录添加停止事实并保留来源/版本关联，不能自动迁移成允许。迁移成功前旧记录仍参与检查。
4. 新旧入口在构造客户端前读取同一来源守卫，并在每批请求前重新核验范围及授权。任何入口遇到拒绝，先持久化共享停止再结束；写入失败、进程中断、并发状态不明也禁止后续请求。
5. 只有统一守卫、来源授权与旧证据核对完成，且总负责人复核后，才另行实现解除本次硬性关闭的代码变更。当前没有 reset/force 或授权文件可直接解锁它。

## 应验收的离线证据

本补丁已加入的用例：共享政策缺失/损坏/暂停/拒绝；其他操作已批准；本操作 approved 但旧状态未整合；空的新目录；更换模式、服务器与股票；新进程；直接调用工厂或内部函数；CLI 在拒绝时不创建输出/状态文件；现有共享政策和本入口旧停止文件不被修改。所有这些用例必须保证客户端创建次数为零。

实际共享迁移后还必须新增：旧入口拒绝后新入口停止、新入口拒绝后旧入口停止、来源别名归并、不同克隆目录共享状态、并发共同锁、旧格式迁移中断、权限中途撤销，以及持久化失败后下一进程仍停止。这些用例依赖旧守卫合同，目前不能标为通过。

离线通过不等于真实采集、数据正确性、Mac 部署、公开再展示权利或完整依赖安全审计通过。

## 2026-11-17 只读来源与状态清单

下表记录源码合同，不表示读取过用户浏览器、Mac、runner 或私有数据库的实际状态。基线为 main 56ab4a9942e3cb43c3a7305cc44b3f23172af206；用户已澄清个人使用，本次停止扩展许可研究，继续定位技术状态与入口。

| 实际范围 | 入口 / 状态位置 | 已确认事实 |
| --- | --- | --- |
| TDX 新入口 | tools/mootdx_feed/collector.py；HOME/.local/state/books/mootdx-feed/source-state.json | schema books.mootdx.guard.v1，in_progress/stopped；已有文件阻止请求。只定义了路径，未发现实际记录。不同 HOME/runner 不共享。 |
| TDX 旧入口 | tools/stock_research/a_share_sources.py、scripts/collect_a_share.py、a-share-collector.yml | 没有持久守卫；默认工厂不经过新入口；旧适配器可能吞掉来源错误并继续下一接口或股票。手动工作流不恢复持久停止状态。 |
| 腾讯行情 | market-strip.js；web.ifzq.gtimg.cn、proxy.finance.qq.com/ifzqgtimg | 同一上游的两个入口。books.indexTape.v1 缓存 closing/delayed/attempted，不是停止记录。当前 401/403/429 只结束当前股票，尚未形成跨轮次来源停止。 |
| 本站公开快照 | stock-workspace.js；localStorage books.stock.published-source-stop.v1 | 值 http_401/403/429，保护 research-data/snapshot.json；不是 TDX 或腾讯记录。首页 home-market-radar.js 尚未共用该键。 |
| 私人研究 API | private-follow/research-shared/stock-workspace.js | 同名 localStorage 键属于不同 origin；保护 /api/research/result。 |
| 私人 Tushare | private-follow/worker/research-data.mjs；数据库 source_stops | research:Tushare 或 research:Tushare:<operation>；不能归入 TDX。未读取真实数据库行。 |
| 其他来源 | scripts/source-holds.json、market-overview.json.sourceStops、audit/github-completed-check-stop.json | Binance、GitHub、BLS 的既有记录保持原位，不能冒充 TDX 拒绝，也不能用其 approved 放行 TDX。 |
| 榜单撤回控制 | home-active-stocks.js | publicationVersion 水位在文档内存中；不是来源停止，仍缺跨重载/标签页持久控制。 |

尚未定位的历史 TDX 停止证据标为 unlocated，不标已迁移，也不从未知状态推导放行。旧 AKShare/adata 的上游必须按实际接口固定核验；同一库可能连接不同上游，不应统一标成一个来源。

下一步技术补丁需要让新旧入口统一检查、拒绝后不回退/不继续下一股票、在请求前写入跨 runner 可继承的未完成状态，并对条件写冲突、崩溃和状态读写失败关闭。此清单本身没有完成这些改动，亦未运行真实采集或变更任何旧停止记录。

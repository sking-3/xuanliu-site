# A 股收盘任务

`books-a-share-daily.timer` 在北京时间周一至周五 15:10–23:50，每10分钟启动一次检查；同一 worker 运行时不并发启动。
worker 使用已核验的交易日历选择最近收盘日，先检查三个指数的目标日日线，来源就绪后才全量采集和计算；当日数据尚未发布时记为等待来源，保留上次成功结果，在后续检查继续，窗口结束后不承诺供应商何时补齐。已经完成的同日结果直接复用；断电后的补跑也按最近收盘日校验。
现有日历只核验至 2026 年，未知年份停止，不推断假期。

采集范围为本站名册中的全部沪深主板，风险名称也保留采集记录，再单独排除筛选资格。北交所和创业板/科创板不在本任务内。
三个筛选共享同一批前复权日线，预计算 20/60 个交易日、三个指数和 120/240/完整参考池。
名册读取 TickFlow 官方沪深交易所证券列表，独立记录读取时间，不再依赖热力图快照日期。接口列出所有收录标的，包含历史已摘牌代码，且未提供活跃状态字段；不能视作活跃股票名单或历史时点成分表。已知上市日在目标日之后的证券排除，未知上市日期保留为空，行业资料未知时留为未分类。日线使用 TickFlow 官方免费服务，不需要注册或 API Key。每只保留最多500根真实日线；股票使用比例前复权，指数不复权，成交量单位为手。每批最多50个标的，串行请求间隔至少1.5秒，低于官方每IP每分钟60次上限；没有新增付费服务。
官方允许本地保存、研究及公开派生统计，禁止重新封装原始行情API：[使用范围和频率](https://docs.tickflow.org/zh-Hans/faq)。公开站只提供衍生筛选结果，日K继续由官方图表组件独立显示。原始日线保存在服务器私有目录和SQLite，不公开分发。
新来源使用独立缓存身份；原有腾讯记录不混入新批次。同一来源同一交易日冻结名册和来源批次时间，中断后复用同批已完成记录。拒绝或限流会持久暂停来源，保留Retry-After，不立即重试。

## 安装与查看

服务器需要 Node 24（内置 `node:sqlite`），站点源码在 `/opt/books/site`。

```sh
install -d -o books -g books -m 700 /var/lib/books/a-share-daily
install -d -o books -g books /var/lib/books/a-share-daily/generations
install -m 644 server/a-share-daily.mjs /opt/books/app/a-share-daily.mjs
install -m 644 server/a-share-tickflow.mjs /opt/books/app/a-share-tickflow.mjs
install -m 644 server/a-share-universe.mjs /opt/books/app/a-share-universe.mjs
install -m 644 server/a-share-pattern-regimes.mjs /opt/books/app/a-share-pattern-regimes.mjs
install -m 644 server/a-share-pattern-precompute.mjs /opt/books/app/a-share-pattern-precompute.mjs
install -m 644 server/a-share-entry-bars.mjs /opt/books/app/a-share-entry-bars.mjs
install -m 644 server/a-share-entry-precompute.mjs /opt/books/app/a-share-entry-precompute.mjs
install -m 644 server/a-share-retention.mjs /opt/books/app/a-share-retention.mjs
install -m 644 server/a-share-worker-exit.mjs /opt/books/app/a-share-worker-exit.mjs
install -m 644 screening/trend-patterns.js /opt/books/site/screening/trend-patterns.js
install -m 644 server/books-a-share-daily.service /etc/systemd/system/
install -m 644 server/books-a-share-daily.timer /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/books-a-share-daily.{service,timer}
systemctl daemon-reload
systemctl enable --now books-a-share-daily.timer
systemctl start --no-block books-a-share-daily.service
systemctl status books-a-share-daily.service
systemctl list-timers books-a-share-daily.timer
journalctl -u books-a-share-daily.service --no-pager -n 20
```

`BOOKS_SITE_DIR` 指定站点源码；`BOOKS_A_SHARE_DIR` 指定任务状态目录，默认 `/var/lib/books/a-share-daily`。
网站服务和 worker 都读取同一目录。无须浏览器在线，也不经过 GitHub 队列。
systemd 同一单元不并行启动，CLI 另有进程锁。

## 结果与失败

SQLite 保存同日、同名册时点的已成功日线；重启后续读尚未完成的证券。
每次外部 HTTP 请求共用 1.5 秒门控；401/403/418/429 持久暂停整个来源，读取 429 的 `Retry-After`，不会自动重试。
解除来源暂停须先核对原因及允许访问时间；核验之前不要删除 SQLite `settings` 中的停止记录。
HTTP 5xx、连接失败或非 JSON 响应会结束整轮采集，失败原因保留 HTTP 状态；传输失败不计作单只股票资料缺失。
systemd 的 `ExecStopPost` 另外接收系统退出原因：OOM、信号或超时导致 JavaScript 无法执行 catch 时，将仍在运行中的回执标成失败，保留原日期和进度，不切发布指针。

完成全量请求、有效覆盖至少 80%、三个指数和全部结果文件预计算后，原子切换 `current.json`。
未完成、名册身份或目标日期错误、拒绝访问、计算失败都只更新 `status.json`，上次成功结果不变。
原始缺失证券保留原因，零命中不会被解释成采集失败。

- `/api/a-share-daily/state`：任务进度、失败原因、上次成功日期。
- `/api/a-share-daily/result?mode=consensus&lookback=20&sampleSize=120&benchmark=000300.SH`：已完成结果。
- `/api/a-share-daily/patterns?generation=批次号`：同一完整批次的固定形态滚动验证统计；缺少完成标记时返回503，不触发采集。
- `/api/a-share-daily/market` 和 `/api/a-share-daily/dataset`：TickFlow批次依据来源使用范围返回403，不提供原始行情查询；旧来源与历史样本按自身规则处理。
- 原始归档位于状态目录的 `private/generations/批次号/`，来源、覆盖数和读取时间记录在完成标记中。公共页面在完整批次可用后读取全量共性结果，历史样本仍明确标注120只。

网站请求只读这些文件，绝不触发逐股采集。控制台 `/control/index.html` 自动更新任务状态。
筛选参数的过热排除复用同一个引擎；参数变化只在已计算指标上过滤，不改变来源日期。

形态标签由统一的 `screening/trend-patterns.js` 生成：均线趋势、均线附近整理、收盘重回/跌破均线、收盘区间突破/回撤和阶段放量/缩量。同一股票可以具有多个标签，依据只使用已存的收盘价与成交量，不判断盘中触线或依赖OHLC的形态。结果含 `patternVersion`、`patternProfile`、`patternDefinitions`，每条记录含 `patterns`；未知标签保留缺失原因。

## 固定形态滚动验证

沿用上述16类固定规则，不聚类或创造新形态。形态首次形成后按下一交易日开盘估算进入，观察后续15个交易日收盘变化，扣除假设的往返0.30个百分点成本；3/5/10/15日描述统计使用同一组已成熟15日样本。回撤是从估算进入价起的收盘路径最大回撤，不是盘中最大亏损。

滚动窗口为120个信号日训练、15日隔离、20日验证；最近180个已成熟信号日保留样本外验证。还需通过近期60日、样本数量、跨日一致性和16类多重比较校验。未通过的形态显示真实统计与原因，不产生推荐。当前候选另需近期形成、刚开始走强且未明显拉升，并与用户现有筛选取交集。

原始长历史仅保存于SQLite和 `private/generations/批次号/history-all.ndjson`；现有三种筛选仍只读取各自61根私有日线。所有派生统计完成后才写完成标记并发布指针。历史统计使用当前名册，存在历史成分和名称变更偏差，页面和结果均保留该限制。服务的Node堆上限为192MB，已在当前VPS真实任务验证；这不是总进程内存上限。

修改规则后，已有同日完整批次可直接离线重算：

```sh
sudo -u books env BOOKS_A_SHARE_DIR=/var/lib/books/a-share-daily BOOKS_SITE_DIR=/opt/books/site /usr/bin/node /opt/books/app/a-share-daily.mjs --recompute-cache
```

此分支沿用进程锁，仅读取当前完成代的三份私有原始归档，不进入采集、不请求外部。核对完整名册、来源、指数和日期后发布新代；原始 `day`、`asOf`、读取时间与 `status.json` 采集回执保持。完成标记写入规则版本、参数口径和 `recomputedFrom`；失败保留旧指针。后续正常收盘任务也自动生成同一套标签。

## 自动压缩与隔离恢复

同一个 worker 锁内，采集前和方案复盘后执行存储维护。默认保留最新 2 个完整热批次，并额外保护所有已发布指针；其余批次无损 gzip 冷存，不按年龄删除唯一历史。原始日线、派生 SVG、来源冻结名册及所有方案/复盘版本均保留。证券列表包含历史退市代码，不能把名册数量当作当前活跃证券数；缺目标日、上市历史不足和来源无返回分别保留诊断，可查 `/api/a-share-daily/coverage?generation=批次号`。

每个文件先压缩，再解压核对字节数与摘要，写入恢复清单后才移除已验证的未压缩副本。旧 SQLite 日期先做逻辑冷归档并隔离恢复核对，再迁移热缓存；保留全部三个指数的长历史、股票和来源状态。方案备份包括 `screening_scheme*` 4 表与存在时的 `research_control_*` 5 表，不复制账户凭据。冷结果由同一只读 API 自动解压，失败保留现有发布指针。

环境参数：`A_SHARE_HOT_GENERATIONS=2`；`A_SHARE_ARCHIVE_RESERVE_BYTES=1073741824`（1 GiB 基础余量）；`A_SHARE_BATCH_RESERVE_BYTES=1073741824`（1 GiB 下一轮写入余量）。容量预检还预留两倍当前 collector.sqlite 用于隔离核验/VACUUM，不足时停止新采集并在控制台说明。压缩能降低增长速度，不能提供无限空间；冷档永久保留，后续磁盘不足需要迁移完整档案而非丢弃历史。`retention-status.json` 和研究控制台显示维护阶段、结果与失败原因。

恢复只写入一个不存在的新目录，不覆盖生产库，不切正式站指针：

```sh
sudo -u books /usr/bin/node --input-type=module -e 'import {restoreGeneration} from "/opt/books/app/a-share-retention.mjs"; console.log(await restoreGeneration({dir:"/var/lib/books/a-share-daily",generation:process.argv[1],target:process.argv[2]}));' 完整批次号 /var/lib/books/restore-check-唯一名称
```

恢复目录含双格式文件、`collector.sqlite`、`schemes.sqlite` 和 `RESTORED.json`。先离线核对再选择性恢复方案，不能将旧备份整库覆盖当前账号/会话库。源访问暂停记录也随来源归档恢复，恢复不解除暂停。

## 关键 K 的时间边界

沿用固定形态首次形成 F；最多 3 个交易日内，阳线收盘超过 F 高点、位于 MA20 上方且量不低于此前 20 日均量时，记录收盘确认关键 K（C）。仅从 C 的下一交易日起，最多 3 个交易日观察严格突破 C 高点（T）；F 最低价为固定失效研究参考位。开盘高于参考位 2% 排除追高；同日双触碰、停牌、一字价日不能假设可成交。晚发现的历史信号不追认为当时可执行。

股票卡片使用统一入口，点击读取同批预计算的研究回放和派生归一化图，F/C/T 标记落在真实日期上。原图组件保留；不向第三方 iframe 注入假箭头，不公开原始 OHLC 查询。`entries?generation=批次号&code=代码` 与 `entry-chart` 为只读历史证据；独立验证及合格观察使用下述新报告，不借用旧形态次日开盘收益。

## 关键 K 独立滚动验证与每日观察

`/api/a-share-daily/entry-validation?generation=批次号` 只读本批完成的派生报告。日常 worker 自动串接统计、当前窗口和发布，失败保留最后完整结果。新报告和 gzip 都存在才允许切换正式指针，版本升级后会补算同日旧批次。

- 收益从首次有效 T 的研究参考价 `max(C高点,T开盘)` 到 T 后第 15 个交易日收盘计算，统一减往返成本/滑点 0.30 个百分点。日内触发时刻和实际成交未知，不标成实盘收益。
- 同期比较另用股票与指数的 T 收盘至 T+15 收盘；不把未知盘中触发时刻的指数开盘当作同刻基准。回撤为 T 至 T+15 收盘路径最大回撤，固定失效位仅记录，不假定止损成交。
- 每股每形态在首次有效 T 先占用 T～T+15 的观察区间，再判断未来收益是否成熟、缺失或不可退出；不能因为未来首笔失败而挑选重叠后笔。未成熟、缺日线、顺序不明、追高和不可执行分别计数，不跳过交易日。
- 原 120 日训练、60 日近期、180 日样本外、20 日验证折、15 日隔离及全部样本/收益/显著性门槛保持。训练收益必须在验证开始前成熟；同触发日合并横截面，T～T+15 共 16 个交易日，独立锚点步长为 16。新 16 类入场假设单独作 Bonferroni 校正，与旧形态家族分开标识。
- “当前观察”仅来自尚在确认/突破期限内、刚开始走强且未明显拉升的真实窗口。合格列表要求同一形态同时通过原门槛和独立入场验证，且计算/发现早于下一已核验开盘；仅供下一交易日条件观察，目标日收盘失效。盘中触发仍须另行核实。
- 未通过门槛或等待新收盘日线的窗口放在明确标注的研究候选中，不与合格机会混用。所有 16 类逐项显示实际值、阈值及未通过原因；即使没有合格机会也不放宽条件。

## 验证命令

```sh
node --test audit/trend-patterns-unit.cjs audit/a-share-daily-unit.mjs audit/a-share-cache-unit.mjs audit/a-share-tickflow-unit.mjs
```

测试使用 mock 请求，不向外部来源发请求。可用 `BOOKS_TEST_DATASET` 指向已保存的真实日线文件，额外检查离线预计算。

停用新任务：`systemctl disable --now books-a-share-daily.timer`，再 `systemctl stop books-a-share-daily.service`。
保留状态目录和 `current.json`，网页仍可读取最后成功批次；不要用中途记录替换完成批次。

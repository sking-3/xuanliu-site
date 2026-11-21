# A 股收盘任务

`books-a-share-daily.timer` 在北京时间周一至周五 20:10 启动独立的 Node worker。
worker 使用已核验的交易日历选择最近收盘日；断电后的补跑也处理这个日期。
现有日历只核验至 2026 年，未知年份停止，不推断假期。

采集范围为本站名册中的全部沪深主板，风险名称也保留采集记录，再单独排除筛选资格。北交所和创业板/科创板不在本任务内。
三个筛选共享同一批前复权日线，预计算 20/60 个交易日、三个指数和 120/240/完整参考池。
名册来源沿用项目已有的公开快照；日线使用 TickFlow 官方免费服务，不需要注册或 API Key。股票使用比例前复权，指数不复权，成交量单位为手。每批最多50个标的，串行请求间隔至少1.5秒，低于官方每IP每分钟60次上限；没有新增付费服务。
官方允许本地保存、研究及公开派生统计，禁止重新封装原始行情API：[使用范围和频率](https://docs.tickflow.org/zh-Hans/faq)。公开站只提供衍生筛选结果，日K继续由官方图表组件独立显示。原始日线保存在服务器私有目录和SQLite，不公开分发。
新来源使用独立缓存身份；原有腾讯记录不混入新批次。同一来源同一交易日冻结名册和来源批次时间，中断后复用同批已完成记录。拒绝或限流会持久暂停来源，保留Retry-After，不立即重试。

## 安装与查看

服务器需要 Node 24（内置 `node:sqlite`），站点源码在 `/opt/books/site`。

```sh
install -d -o books -g books -m 700 /var/lib/books/a-share-daily
install -d -o books -g books /var/lib/books/a-share-daily/generations
install -m 644 server/a-share-daily.mjs /opt/books/app/a-share-daily.mjs
install -m 644 server/a-share-tickflow.mjs /opt/books/app/a-share-tickflow.mjs
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

完成全量请求、有效覆盖至少 80%、三个指数和全部结果文件预计算后，原子切换 `current.json`。
未完成、名册日期滞后、拒绝访问、计算失败都只更新 `status.json`，上次成功结果不变。
原始缺失证券保留原因，零命中不会被解释成采集失败。

- `/api/a-share-daily/state`：任务进度、失败原因、上次成功日期。
- `/api/a-share-daily/result?mode=consensus&lookback=20&sampleSize=120&benchmark=000300.SH`：已完成结果。
- `/api/a-share-daily/market` 和 `/api/a-share-daily/dataset`：TickFlow批次依据来源使用范围返回403，不提供原始行情查询；旧来源与历史样本按自身规则处理。
- 原始归档位于状态目录的 `private/generations/批次号/`，来源、覆盖数和读取时间记录在完成标记中。公共页面在完整批次可用后读取全量共性结果，历史样本仍明确标注120只。

网站请求只读这些文件，绝不触发逐股采集。控制台 `/control/index.html` 自动更新任务状态。
筛选参数的过热排除复用同一个引擎；参数变化只在已计算指标上过滤，不改变来源日期。

形态标签由统一的 `screening/trend-patterns.js` 生成：均线趋势、均线附近整理、收盘重回/跌破均线、收盘区间突破/回撤和阶段放量/缩量。同一股票可以具有多个标签，依据只使用已存的收盘价与成交量，不判断盘中触线或依赖OHLC的形态。结果含 `patternVersion`、`patternProfile`、`patternDefinitions`，每条记录含 `patterns`；未知标签保留缺失原因。

修改规则后，已有同日完整批次可直接离线重算：

```sh
sudo -u books env BOOKS_A_SHARE_DIR=/var/lib/books/a-share-daily BOOKS_SITE_DIR=/opt/books/site /usr/bin/node /opt/books/app/a-share-daily.mjs --recompute-cache
```

此分支沿用进程锁，仅读取当前完成代的三份私有原始归档，不进入采集、不请求外部。核对完整名册、来源、指数和日期后发布新代；原始 `day`、`asOf`、读取时间与 `status.json` 采集回执保持。完成标记写入规则版本、参数口径和 `recomputedFrom`；失败保留旧指针。后续正常收盘任务也自动生成同一套标签。

## 验证与回滚

```sh
node --test audit/trend-patterns-unit.cjs audit/a-share-daily-unit.mjs audit/a-share-cache-unit.mjs audit/a-share-tickflow-unit.mjs
```

测试使用 mock 请求，不向外部来源发请求。可用 `BOOKS_TEST_DATASET` 指向已保存的真实日线文件，额外检查离线预计算。

停用新任务：`systemctl disable --now books-a-share-daily.timer`，再 `systemctl stop books-a-share-daily.service`。
保留状态目录和 `current.json`，网页仍可读取最后成功批次；不要用中途记录替换完成批次。

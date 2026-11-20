# A 股收盘任务

`books-a-share-daily.timer` 在北京时间周一至周五 16:30 启动独立的 Node worker。
worker 使用已核验的交易日历选择最近收盘日；断电后的补跑也处理这个日期。
现有日历只核验至 2026 年，未知年份停止，不推断假期。

采集范围为本站名册中的沪深主板、排除风险名称，北交所和创业板/科创板不在本任务内。
三个筛选共享同一批前复权日线，预计算 20/60 个交易日、三个指数和 120/240/完整参考池。
名册来源沿用项目已有的免费公开快照，日线沿用现有腾讯公开网页行情路径；没有新增付费服务或鉴权。
1.5 秒是本站保守请求间隔，不代表来源提供了调用配额或可用性承诺。

## 安装与查看

服务器需要 Node 24（内置 `node:sqlite`），站点源码在 `/opt/books/site`。

```sh
install -d -o books -g books -m 700 /var/lib/books/a-share-daily
install -m 644 server/a-share-daily.mjs /opt/books/app/a-share-daily.mjs
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
- `/api/a-share-daily/market`：同批完整市场名册。
- `/api/a-share-daily/dataset?sampleSize=120&benchmark=000300.SH&generation=批次号`：同批原始归档。

网站请求只读这些文件，绝不触发逐股采集。控制台 `/control/index.html` 自动更新任务状态。
筛选参数的过热排除复用同一个引擎；参数变化只在已计算指标上过滤，不改变来源日期。

## 验证与回滚

```sh
node --test audit/a-share-daily-unit.mjs audit/a-share-cache-unit.mjs
```

测试使用 mock 请求，不向外部来源发请求。可用 `BOOKS_TEST_DATASET` 指向已保存的真实日线文件，额外检查离线预计算。

停用新任务：`systemctl disable --now books-a-share-daily.timer`，再 `systemctl stop books-a-share-daily.service`。
保留状态目录和 `current.json`，网页仍可读取最后成功批次；不要用中途记录替换完成批次。

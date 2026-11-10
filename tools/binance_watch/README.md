# Binance Python 仓位观察器

目标：只读观察 [5075281354358777856 的公开仓位](https://www.binance.com/zh-CN/copy-trading/lead-details/5075281354358777856)。Python 3.11 标准库实现，无第三方 Python 依赖，无交易功能、钱包连接、API Key 或登录 Cookie。

## 当前启用状态

**真实来源采集默认关闭。** 当前 push、pull_request、workflow_dispatch 只运行离线测试；monitor job 明确跳过，定时 cron 尚未启用。尚未完成该目标公开读取权限、网页接口频率及限流边界验证，不能声称已接通或已经每 5 秒读取币安。下面是已实现、待启用的运行配置，不是已发生的生产采集。启用需要在验证后提交可审查的工作流变更，不能用清空停止状态替代。

## GitHub 运行配置（待启用）

工作流：[`binance-python-watch.yml`](../../.github/workflows/binance-python-watch.yml)。

- 待启用方案的定时点为每小时第 3、18、33、48 分钟；每次运行最多 840 秒（14 分钟）。当前 cron 只保留为注释。
- 正常运行期间以 **5 秒为目标检查节拍**，不重叠请求、不补发错过的节拍。响应较慢时会跳过节拍。
- 每轮先核验准确组合 ID、ACTIVE 状态和 `positionShow=true`，再读取仓位；两次来源请求至少相隔 2 秒。
- 本目录或工作流的代码进入 main 后，push 验证运行 60 秒。手动触发可选择有界运行时间。
- 与既有币安采集共用来源任务并发锁，并双向核验停止记录；不会同时请求来源。不循环提交 Git 快照。
- 每次结束将 SQLite 检查点保存为 `binance-watch-state` Actions artifact，下一次读取同工作流之前运行的有效检查点。保留期 30 天。

**GitHub 托管执行不能保证全天连续每 5 秒。** 即使定时任务准时，也有约 1 分钟的计划间隙，另有排队、环境启动和状态交接耗时。GitHub 定时任务还可能延迟。旧网站全量刷新会持有来源锁约几十分钟，此时本监控等待；旧刷新任务等待监控时，也可能间接推迟网站的数据发布。纯界面修改不占来源锁。定时监控只使用本轮创建后 840 秒内的剩余预算，过期本轮跳过，不能把排队积压变成连续补采。没有运行的时间就是观察盲区，不能补成连续监控。来源本身何时更新也没有秒级保证。

每 5 秒两次请求相当于连续运行时每天约 34,560 次来源请求；实际次数受运行间隙影响。本工具没有把该数值当作币安公布的配额。遇到限流或访问拒绝即持久停止，不换 IP、端点、身份或客户端重试。

## 数据及状态

只使用新版 Copy Trading 的 `portfolioId`。不将数字组合 ID 错当作旧排行榜的 `encryptedUid`。

- 首次有效快照仅建立基线，不把已有仓位报为新开仓。
- 比较规范化十进制数量；`1` 与 `1.0` 不产生伪变化。
- 记录仓位出现、数量增加或减少；仓位连续两次缺失才确认从快照消失。
- 空仓也是有效快照，因此空仓之后首次出现的仓位可以被观察到。
- 重启、观察中断或请求失败后重新建立基线，不能断言盲区内发生了什么。
- `observedAt` 是本工具实际读取时间。来源未给更新时间时保持空值，不能用读取时间冒充成交时间。
- 这些是**仓位快照变化**，不是逐笔成交或完整交割单。无法捕捉两个快照之间已经开平的仓位，也不能从仓位差值判断具体成交价格、手续费或精确开仓时间。
- 保留最新快照和最多 10,000 条观察事件，不无限保存每 5 秒的完整仓位。

HTTP 401/403/418/429、挑战响应、来源业务错误、隐藏仓位、身份不符或结构变化均停止本监控；下一次任务读取停止状态后不会继续来源请求。仓库现有 `trader/binance/portfolios.json` 和旧版 `snapshot.json` 的停止状态同样检查。

HTTP 202/401/403/418/429/451 和来源业务拒绝沿用仓库原有全局停止口径，旧采集器也会停止请求。仅目标组合的明确隐私/非活跃状态不会自动关闭另外三个公开组合；未知或不完整的交接记录仍停止对应采集并要求检查。

上次运行异常中断、状态缺失、损坏、已过期或无法证明此前未运行时，停止并在 Actions 日志说明原因。只有可确认的首次运行可以初始化空状态。不要通过删除 artifact、重置数据库或重复运行来清除拒绝记录。

## 本地检查与运行

离线测试（不会访问币安）：

```bash
python3 -B -m unittest discover -s tools/binance_watch -p 'test_*.py' -v
```

查看已有状态（不会访问币安）：

```bash
python3 -B tools/binance_watch/monitor.py --state-db /path/to/watch.sqlite3 --status
```

以下为核验通过后可使用的有界观察命令，当前上线验收不执行它：

```bash
python3 -B tools/binance_watch/monitor.py \
  --interval 5 \
  --duration-seconds 60 \
  --state-db /path/to/watch.sqlite3 \
  --repo-snapshot trader/binance/portfolios.json
```

不要同时启动第二个本地采集进程；程序使用排他锁。常驻云服务器当前未配置，不能把此 GitHub 工作流称为已部署的全天守护服务。

## 验收

在仓库 Actions 中打开 **Bounded Binance Python watch**。当前应看到离线测试通过、Monitor public positions 被跳过。后续启用后，分别检查触发类型、实际开始和结束时间、轮次日志、停止原因以及 artifact。`push` 或 `workflow_dispatch` 成功不等于 `schedule` 已验收；必须有实际 `event=schedule` 记录。

检查点和日志位于 GitHub Actions，本次未将它们写入带单员广场，也未开启消息通知或自动跟单。网站现有快照和本观察器的时间含义相互独立。

## 官方运行限制

[GitHub 的 schedule 文档](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)说明定时最小间隔为 5 分钟，并可能出现延迟。本方案的 5 秒节拍发生在已启动的 Python 进程内，不是 5 秒 cron。

# mootdx 行情采集入口

为首页“沪深成交活跃榜”准备可核查的日线输入，也支持单次报价和历史分笔采样。这是仓库中的可运行采集工具，**尚未接入首页、没有日更排程，也不代表全市场热度榜已上线**。

旧的多来源入口仍在 `tools/stock_research/a_share_sources.py`。本入口使用独立依赖环境，避免与旧适配器及待复核修复交叉修改。不要在同一虚拟环境同时安装两个 requirements 文件。

## 安装与启用状态

此入口**默认禁用网络**，PR 仍处于复核阶段。当前修复仅支持 Linux/macOS 的 POSIX 文件保护机制；没有 Windows 支持承诺。依赖版本与哈希锁定正在补齐，现有安装测试不能称为依赖安全审计。

在仓库根目录，使用独立 Python 3.11 或 3.12 环境；不要与旧适配器混用依赖：

```bash
python3 -m venv /tmp/books-mootdx-venv
source /tmp/books-mootdx-venv/bin/activate
python -m pip install -r scripts/requirements-mootdx.txt
```

## 手动采集与持久停止

普通命令只返回 `network_disabled`，不会初始化客户端。启用时必须同时指定 `--enable-network` 和已获准访问的单个 IPv4 地址、端口。没有内置默认服务器，没有域名解析、IP 探测、自动重连或服务器回退。下方 `MOOTDX_SERVER` 必须由实际部署者设置为已核实可用且获准使用的 `IPv4:port`，不能把更换地址作为访问拒绝后的恢复方式。

```bash
python -m tools.mootdx_feed.collector --enable-network --server "$MOOTDX_SERVER" \
  --mode daily --symbols 000001.SZ,600519.SH,300750.SZ,688981.SH --rows 60

python -m tools.mootdx_feed.collector --enable-network --server "$MOOTDX_SERVER" \
  --mode quotes --symbols 000001,600300

python -m tools.mootdx_feed.collector --enable-network --server "$MOOTDX_SERVER" \
  --mode transactions --symbols 000001.SZ --date 2025-06-24 --rows 10
```

采集前先在 `~/.local/state/books/mootdx-feed/source-state.json` 独占写入运行记录并落盘，之后才能创建客户端。任何请求异常（包括拒绝、超时、空返回、校验失败和中断）都会留下停止记录。后续进程、其他模式、股票或服务器都使用同一个守卫，遇到既有记录立即退出；损坏记录、符号链接和并发运行也会阻止联网。成功采集才移除运行记录。程序没有 reset、force 或自定义状态路径选项。异常中断遗留的记录须先查明原因并交维护者复核，不自动重试或清除。

mootdx 0.11.7 的原始 `Quotes.factory` 会在缺失或损坏配置时扫描服务器，即使设置 `bestip=False` 也无法阻止。本入口直接构建单一 TDX 传输连接，复用固定版本的报价、日线和分笔解析方法，跳过 `BaseQuotes/StdQuotes.__init__` 和 `config.setup()`；不读取或改写原 mootdx 配置。这一有限适配依赖已锁定的 mootdx/tdxpy 版本，升级必须重新测试。

每批最多 50 只输入股票；日线/分笔每只最多 800 行。日线使用 frequency=9，可能含当日未完成行。`--timeout` 为 1–30 秒。任何失败都终止本批次，没有部分成功结果。

## 私人输出

输出只允许在 `~/.local/share/books/mootdx-feed/` 中保存，目录必须归当前用户所有且权限为 0700，文件为 0600。默认名称为“模式 + 随机标识”。可用 `--output daily-my-sample.json` 指定新的合规文件名，不能指定其他目录。

工具拒绝覆盖**所有已有目标**，包括本工具的旧快照、其他格式、硬链接和符号链接。完成写入后通过不可覆盖的原子链接发布新文件；并发抢占文件名也不会替换已有内容。路径逐层拒绝符号链接。失败不会修改原快照、刷新原数据日期或上传任何数据。

`std` 对应沪深标准市场；本入口只接收沪深 A 股代码，不接收指数、ETF、B 股和北交所代码。代码格式校验不等于已核实上市状态。输出的 `scope=supplied_stock_sample` 明确是输入样本，不能标为“全市场”。

## 日期、单位和后续榜单

- `fetchedAt` 仅为本机获取时间，不能替代证券行情时间。
- 报价只有时分秒时，保留 `sourceClock`，`sourceAsOf` 为 null，不宣称实时。
- 日线保留来源日期，检查重复日期、未来日期、OHLC 和有限非负数值；不填补缺日。当前日期行标 `isCurrentDate=true`，`sessionComplete` 保持未知。
- 分笔记录保留请求日期和来源时刻；请求参数本身不是数据日期证明。
- 成交额、成交量分别保留为 `amountRaw`、`volumeRaw`。在真实样本与来源字段单位完成对账前，不擅自乘 100、1,000 或 10,000，不将它们标为元或股。
- 后续五日活跃榜仍需要：经核实的上市名册和交易日历、同一五个完整交易日的覆盖、成交额单位、数据使用权限。不得拿最近任意五行冒充最近五个交易日。
- 工具没有下单功能。没有上传行情文件、交易账户资料或密钥的流程。输出只在私人路径保存，`redistributionAllowed=false`；代码获准上传不代表行情再分发获准。

## 通达信本地文件

若已有通达信本地目录，可直接使用上游 Reader：

```python
from mootdx.reader import Reader
reader = Reader.factory(market="std", tdxdir="C:/new_tdx")
daily = reader.daily(symbol="600036")
```

## 测试与运行边界

```bash
python -B -m unittest tools.mootdx_feed.test_collector -v
```

GitHub Actions 的 `Verify mootdx feed` 使用 Python 3.11/3.12 和真实安装的固定版本包进行离线模拟。测试拦截 socket，覆盖上游扫描触发条件、固定服务器适配、跨进程停止记录、输出路径限制与并发覆盖保护。它不连接真实通达信、不生成或上传行情产物，也不证明数据源可用、行情准确或依赖经过完整安全审计。真实连通性、数据日期、单位和公开展示权利仍未验收。

GitHub Pages 是静态网站，不能运行 Python 或 TCP 行情采集。安装到仓库也不会自动建立常驻服务。是否能连通与网络、服务端状态和访问策略有关；不能保证没有 IP 限制、不会超时，不能保证某个地区一定可用或不可用。

## 上游依据

- [mootdx 0.11.7 发布页与安装说明](https://pypi.org/project/mootdx/0.11.7/)
- [固定版本 Quotes API 源码](https://github.com/mootdx/mootdx/blob/v0.11.7/mootdx/quotes.py)
- [固定版本 DataFrame 转换源码](https://github.com/mootdx/mootdx/blob/v0.11.7/mootdx/utils/__init__.py)

上游标示 MIT 软件许可证，并在项目介绍中声明用于学习交流、不得用于商业目的。这些文字不构成通达信行情的公开再展示授权；公开榜单启用前仍需核实数据权利。

# mootdx 行情采集入口

为首页“沪深成交活跃榜”准备可核查的日线输入，也支持单次报价和历史分笔采样。这是仓库中的可运行采集工具，**尚未接入首页、没有日更排程，也不代表全市场热度榜已上线**。

旧的多来源入口仍在 `tools/stock_research/a_share_sources.py`。本入口使用独立依赖环境，避免与旧适配器及待复核修复交叉修改。不要在同一虚拟环境同时安装两个 requirements 文件。

## 安装

在仓库根目录，推荐 Python 3.11 或 3.12：

```bash
python3 -m venv /tmp/books-mootdx-venv
source /tmp/books-mootdx-venv/bin/activate
python -m pip install -r scripts/requirements-mootdx.txt
```

Windows 可在仓库外建立虚拟环境，PowerShell 激活命令为 `环境目录\Scripts\Activate.ps1`。本项目固定 mootdx 0.11.7 和 pandas 2.2.3；上游也提供 `pip install -U 'mootdx[all]'` 的通用安装方式，但本项目测试按固定版本执行。

## 单次采集

输出必须放在仓库目录以外；示例路径适用于 Mac/Linux，可替换为自己的私人目录。默认只采输入股票，最多 50 只；日线与分笔每只最多 800 行，没有循环重试或自动切换服务器。

日线（`frequency=9`，最近 60 行，包含来源可能返回的当日未完成行）：

```bash
python -m tools.mootdx_feed.collector --mode daily \
  --symbols 000001.SZ,600519.SH,300750.SZ,688981.SH \
  --rows 60 --output /tmp/books-mootdx/daily.json
```

报价：

```bash
python -m tools.mootdx_feed.collector --mode quotes \
  --symbols 000001,600300 \
  --output /tmp/books-mootdx/quotes.json
```

历史分笔：

```bash
python -m tools.mootdx_feed.collector --mode transactions \
  --symbols 000001.SZ --date 2025-06-24 --rows 10 \
  --output /tmp/books-mootdx/transactions.json
```

可以使用 `--timeout 10` 设置连接超时，或用 `--server IP:7709` 指定自己获准使用的服务器。默认沿用 mootdx 的服务器配置，关闭 bestip 扫描、heartbeat 和 auto_retry。一次请求超时、拒绝、空返回或字段异常会终止本批次；不改用其他服务器掩盖失败。成功后写入新文件，失败保留原文件及其真实时间，命令退出码为 2。遇到访问拒绝后应先确认原因及访问许可，不能通过再次运行或换服务器绕过限制。

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

GitHub Actions 的 `Verify mootdx feed` 在 Python 3.11/3.12 上安装依赖、检查真实包导入，并用模拟客户端验证数据处理、失败停止、连接关闭和旧文件保留。它**不连接通达信行情服务器**，不生成或上传行情产物。真实 TCP 连通性与数据单位仍需在用户实际机器上对账。

GitHub Pages 是静态网站，不能运行 Python 或 TCP 行情采集。安装到仓库也不会自动建立常驻服务。是否能连通与网络、服务端状态和访问策略有关；不能保证没有 IP 限制、不会超时，不能保证某个地区一定可用或不可用。

## 上游依据

- [mootdx 0.11.7 发布页与安装说明](https://pypi.org/project/mootdx/0.11.7/)
- [固定版本 Quotes API 源码](https://github.com/mootdx/mootdx/blob/v0.11.7/mootdx/quotes.py)
- [固定版本 DataFrame 转换源码](https://github.com/mootdx/mootdx/blob/v0.11.7/mootdx/utils/__init__.py)

上游标示 MIT 软件许可证，并在项目介绍中声明用于学习交流、不得用于商业目的。这些文字不构成通达信行情的公开再展示授权；公开榜单启用前仍需核实数据权利。

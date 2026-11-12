# 跟单管理与离线计算

公开网站已撤下跟单、API 管理和公开 JSON 配置入口。用户已选择当前 ChatGPT 账号的[私人跟单站](https://books-private-follow.rr7jp4d56w.chatgpt.site)，由 Sites 仅所有者访问名单与 Worker 的本站身份校验共同保护；不是客户端密码门。本人实际登录、所有者绑定与私人设置保存到 D1 已验证，具体服务边界见 [private-follow/README.md](../../private-follow/README.md)。

私人站使用原生 `OWNER_ID` 和 `CREDENTIAL_ENCRYPTION_KEY` Secrets。用户只在受认证的私人账户接入页输入凭证，服务端加密保存；不向聊天、公开仓库、网址、本机模拟账本或日志提供凭证。当前只实现固定端点的只读账户验证，未提供或测试用户真实交易凭证，没有下单或转账实现。保存设置、配置 Secret 或账户读取成功都不代表后台跟单或实盘启用。此前 GitHub Secrets 管理页的权限仍依 GitHub 授权范围，不能将它另行称为仅本人可见。

原 `Copy signal dry-run` 云端配置试运行已撤下，仅保留离线单元检查，工作流名称改为 `Copy signal offline checks`。无配置路径输入、实时 checkpoint 请求、状态 cache 或报告 artifact。熬鹰的原每五秒公开来源观察器保持原状。此目录和本机模拟代码不作为 Pages 网站资产发布。

私人 `/paper` 复用原 Hyperliquid / USDC 本机模拟引擎；账本仍在当前浏览器，旧公开域名账本未删除且不会自动跨域迁移。私人服务以固定 GitHub Contents 端点只读既有检查点，D1 原子预算限制为每 75 秒最多一次上游尝试；不查询或触发 Actions 队列。403/429 持久停止且不切换端点，缓存保留原始来源时间。来源五秒观察节拍不等于页面五秒发现，页面也不是后台执行服务。生产私人页已读取新鲜检查点，建立模拟 10,000 USDC 账本并启动建基线后立即暂停，保留账本；模拟与跳过均为 0，没有复制仓位或记录，尚未验证新信号成交。

公开功能代码已直接提交 main 并部署，未经过 PR 合并；公开资源字节与本地一致，Pages 未发布私人 Worker。真实公开站浏览器已核验官方实时流、两个当前仓位、25 个真实盈亏样本、ETH 的 97 根真实 15 分钟 K 线及折叠历史统计，控制台无错误日志；390×640 CSS 视口无外层溢出，未作实体移动设备验证。具体部署基线见私人服务说明。

`plan.py` 保留为非执行性计算研究代码，`executable:false`、`ordersSent:0`，没有真实交易实现。首次记录只建基线，过期、歧义记录和断档按检查处理；减少仓位没有目标仓位证据时不猜数量。旧示例从当前发布中撤下，Git 历史中的默认示例不是密钥，也不能通过删除当前文件令历史变为私密。

离线检查：`python3 -B -m unittest discover -s tools/copy_plan -p 'test_*.py'`。合成数据仅存在于测试进程，不进入正式行情或账本。

权限依据：[GitHub Secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)、[GitHub Actions 安全说明](https://docs.github.com/en/actions/reference/security/secure-use)。

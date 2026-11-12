# 跟单管理与离线计算

公开网站已撤下跟单、API 管理和公开 JSON 配置入口。当前管理目的地仅为 GitHub 受保护的 Secrets 管理页，权限由 GitHub 服务端验证；当前没有网站内的私有跟单面板、登录服务或客户端密码门。

用户直接在受保护的 GitHub Secrets 管理页录入凭证，不向聊天、公开仓库、网址、本机模拟账本或日志提供凭证。当前跟单流程不会读取交易凭证或签名下单；填入 Secrets 不等于已接通交易所。GitHub 授权的协作者也可能具有管理或通过工作流使用 Secrets 的权限，尚未核验全部协作者及组织策略，不能把这一管理页称为仅限本人账号或单一电脑。正式接入及实盘启用仍须另外验证。

原 `Copy signal dry-run` 云端配置试运行已撤下，仅保留离线单元检查，工作流名称改为 `Copy signal offline checks`。无配置路径输入、实时 checkpoint 请求、状态 cache 或报告 artifact。熬鹰的原每五秒公开来源观察器保持原状。此目录和本机模拟代码不作为 Pages 网站资产发布。

`plan.py` 保留为非执行性计算研究代码，`executable:false`、`ordersSent:0`，没有真实交易实现。首次记录只建基线，过期、歧义记录和断档按检查处理；减少仓位没有目标仓位证据时不猜数量。旧示例从当前发布中撤下，Git 历史中的默认示例不是密钥，也不能通过删除当前文件令历史变为私密。

离线检查：`python3 -B -m unittest discover -s tools/copy_plan -p 'test_*.py'`。合成数据仅存在于测试进程，不进入正式行情或账本。

权限依据：[GitHub Secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)、[GitHub Actions 安全说明](https://docs.github.com/en/actions/reference/security/secure-use)。

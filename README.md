# 私人云端模板（V2）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/1yyy21/private-cloud-worker-template)

这是给每位玩家单独部署的后台消息云端。一个云端可以绑定多台设备；每台设备使用独立凭据、设置和推送订阅，消息不会因为新增设备而覆盖其他设备。部署后，Worker、数据库与推送配置都归玩家自己的 Cloudflare 账户所有；模板仓库和站点维护者不会得到访问权限。

此模板必须与客户端的 `privateCloudParityV2` / `candidateContractV2` 合约配套。旧版 V1 Worker 不会被客户端自动接受，也不会覆盖玩家已有数据。

## 只需三步

1. 点击上方 **Deploy to Cloudflare**，登录 Cloudflare 与 GitHub。
2. 保持默认配置并确认部署。若页面把“部署命令”预填为 `npx wrangler deploy`，改成 `npm run deploy`；该命令会先应用 D1 迁移，再部署 Worker。Cloudflare 会自动创建 Worker 和数据库。
3. 部署完成后，复制页面提供的 `https://*.workers.dev` 地址，回到应用的「我的私有云端」点击“已有地址”并粘贴。

无需填写 VAPID、数据库 ID、SQL、API Key 或其他密钥。部署完成后，访问 `/config` 应返回 `version: 2`、`privateCloudParityV2: true` 和 `candidateContractV2: true`；如果没有这些字段，说明仍连接到了旧版模板。

## 数据范围

后台消息运行时需要保存角色快照和已配置的文字 API，因此这些内容只存在玩家自己的 Worker 与数据库中。聊天图片不会同步。

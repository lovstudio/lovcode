---
"lovcode": minor
---

MaaS registry 重构 + 内联 provider/model picker：

- **Vendor 概念**：区分「训练模型的厂商」（anthropic/openai/…）与「接入平台」（zenmux/modelgate/…）。`MaasProvider` 新增 `vendors[]`，`MaasModel` 通过 `vendor` 字段引用。
- **Token 内联存储**：`authEnvKey` → `authToken`（明文存于 `~/.lovstudio/maas_registry.json`，首次读取时自动迁移）。
- **Verified 状态**：新增 `lastVerifiedAt` + `lastVerifiedTokenHash` 指纹，token 改动后 verified 状态自动失效。
- **模型元数据扩展**：`MaasModel` 新增 `description` / `iconUrl` / `inputModalities` / `outputModalities` / `contextWindow`。
- **`fetchCommand`**：支持从远端拉取 provider 模型列表的自定义命令。
- **Settings/MaaS 页面重做**：支持 vendors 管理、Verify 按钮、模型拉取、富模型信息展示（~1200 行）。
- **Chat 底部 provider/model picker**：session 详情底部输入框内联显示当前 provider/vendor/model，点击切换（MRU 记忆最近 5 个选择，跨会话持久化）。Coming-soon providers 灰显。

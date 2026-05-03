# Changelog

## 0.32.0 - 2026-05-03

### Minor Changes

- Chat 路径链接支持在 Lovcode 内联预览文件：点击本地路径会打开可调宽的右侧预览区，小屏幕自动降级为浮层预览；支持目录浏览、面包屑导航、返回历史和图片信息展示。
- Prompt 与聊天内容中的本地路径识别增强：支持 `src/foo.tsx:217:7`、`@src/foo.tsx:217:7` 以及带 DOM selector 的定位格式，并在预览中直接跳转到目标行列。
- 全局搜索覆盖层新增 All / Full text / Session ID / Details 模式，可按会话 ID、元数据或全文索引分域搜索，并显示命中类型。
- 文档阅读器左右侧栏改为可拖拽调整宽度，布局会持久化保存。

### Patch Changes

- 修复文件预览首次打开时 Monaco 尚未挂载导致行号定位需要点击两次的问题。
- 文件元数据接口补充 `is_dir`，让前端能区分文件与目录并选择正确预览方式。

## 0.31.0

### Minor Changes

- 架构重构：移除 Workspace dashboard，转向页面中心化路由。

  - **移除 Workspace dashboard**：删除 `WorkspaceView`、`ProjectDashboard`、`ProjectSidebar`、`KanbanBoard`、`GitHistory`、`LogoManager`、`ProjectDiagnostics`、`FeatureSidebar`/`FeatureTabs` 全套模块，及 `PanelGrid`/`SessionPanel`。功能太杂、入口太深，KISS 重构。
  - **`/chat/*` → `/history/*`**：路由更名，同时清掉 `useFeatureCreation`、`useNavigation` 这些只为旧 dashboard 服务的 hook。
  - **`/knowledge/reference`（静态） → `/knowledge/source/[id]`（动态）**：知识库改为按 source 动态路由，新增 `SourceView` + `[...docPath]` 子路由。
  - **新增 `useStreamedSessions` hook**：session 列表流式渲染，长列表首屏更快。
  - **Splash 时序**：根布局延迟到 `/history` 的 `ProjectList` 触发 `app:ready` 才隐藏 splash，初次进入不再先看到空壳再被填充。
  - **Tauri backend (`lib.rs`)**：大量后端重写以支撑新结构；移除 `workspace_store`、`workspaceDataAtom` 等过时持久化。
  - **设置页清理**：移除 `/settings/llm`（LLM 配置移出 app，由统一 platform 接管）。
  - **GlobalHeader 瘦身**：删除 `GlobalFeatureTabs`、`CreateFeatureDialog`、`VerticalFeatureTabs`。
  - **杂项**：`ProjectLogo` 提升到 `components/shared`；`.claude/`、`output/` 加入 `.gitignore`。

## 0.30.1

### Patch Changes

- 修复 dev 模式下偶发的 `[TAURI] Couldn't find callback id` 警告：

  - StatusBar 的 `get_network_info` 调用从挂载即触发改为下一个宏任务，HMR full-reload 期间几乎不会再撞上 5 秒 in-flight invoke。
  - `NETWORK_INFO_CACHE` 增加磁盘持久化（`~/.lovstudio/lovcode/cache/network.json`），dev 重启 Rust 进程不再丢缓存。

  附带修复：annual-report-2025 路由不再被记录为 lastPath 恢复目标。

## 0.30.0

### Minor Changes

- 1df7647: Chat session 列表与全局搜索增强：

  - **Session 标题机制重构**（对齐 Claude Code 源码 `readLiteMetadata`）：后端 head/tail 64KB 双窗口扫描，按优先级识别 `customTitle` → `aiTitle` → `slug` → `summary` → `lastPrompt`，新增 `title_source` 字段透出来源类型。前端用一颗多用途圆点表达「来源 + 是否置顶」（custom 黑、AI 陶土、summary 蓝、slug 绿、prompt 浅灰、none 极浅灰），无 badge 文字干扰；prompt/none 来源走 italic + 灰提示「此为兜底」。
  - **修复连续 user 消息被合并显示的 bug**：`groupConsecutiveByRole` 不再把同 role 的 user 消息合并成一组，每条独占。
  - **`/clear` 等内置 slash command 正确格式化**：`restoreSlashCommand` 支持 `<command-name>` 在前的乱序结构；同时清理 `<local-command-{caveat,stdout,stderr}>` 内部 tag。
  - **全局聊天搜索**：新增 `GlobalChatSearch` + `search-overlay` 路由，跨 session 全文搜索。
  - **Prompt 详情独立窗口**：双击 user prompt 在独立 webview 窗口打开（`prompt-detail` 路由），方便长 prompt 阅读。
  - **Recent header 工具栏常驻可见**：图标改为 `SlidersHorizontal`（语义匹配「分组/排序/过滤」），不再仅在 hover 显示。
  - **Session 列表项右侧 round 数移除**：减少视觉噪音，详情 header 仍保留。
  - **Features view 改造**：`VerticalFeatureTabs` + `FeaturesLayout` + `FeaturesView` 重构。
  - **底层性能**：session 列表元数据从「全文件全量 JSON 解析」改为「128KB 字节级扫描 + 单次 substring 全扫做 round 计数」，对几十 MB 的长 session 文件显著加速。

## 0.29.0

### Minor Changes

- bbff453: MaaS registry 重构 + 内联 provider/model picker：

  - **Vendor 概念**：区分「训练模型的厂商」（anthropic/openai/…）与「接入平台」（zenmux/modelgate/…）。`MaasProvider` 新增 `vendors[]`，`MaasModel` 通过 `vendor` 字段引用。
  - **Token 内联存储**：`authEnvKey` → `authToken`（明文存于 `~/.lovstudio/maas_registry.json`，首次读取时自动迁移）。
  - **Verified 状态**：新增 `lastVerifiedAt` + `lastVerifiedTokenHash` 指纹，token 改动后 verified 状态自动失效。
  - **模型元数据扩展**：`MaasModel` 新增 `description` / `iconUrl` / `inputModalities` / `outputModalities` / `contextWindow`。
  - **`fetchCommand`**：支持从远端拉取 provider 模型列表的自定义命令。
  - **Settings/MaaS 页面重做**：支持 vendors 管理、Verify 按钮、模型拉取、富模型信息展示（~1200 行）。
  - **Chat 底部 provider/model picker**：session 详情底部输入框内联显示当前 provider/vendor/model，点击切换（MRU 记忆最近 5 个选择，跨会话持久化）。Coming-soon providers 灰显。

## 0.28.0

### Minor Changes

- Chat session detail upgrades:

  - 会话详情底栏新增 provider / model / context window 占用展示（peak 单回合 input + cache 总和），后端新增 `get_session_usage` 按需读取真实用量
  - "messages" 计数改为 "rounds"（仅统计用户 prompt，剔除工具调用与 meta）
  - Markdown 链接 `[text](path)` 接入智能路径解析：命中本地文件时渲染 PathLink（存在性检查 + 右键菜单），外链走原系统打开
  - 路由刷新后恢复上次所在页面，不再强制跳回 Dashboard
  - 代码块 / 链接渲染细节修复（去除双层 border、prose-pre 背景透明化）

## 0.27.0

### Minor Changes

- 9dcd673: Chat experience upgrades:

  - 数据源细分为 cli / app-code / app-web / app-cowork，会话详情支持双层 tab 切换
  - 会话详情底部支持直接输入消息继续对话
  - 会话详情合并同角色连续消息，菜单分组重构
  - Chat markdown 渲染升级：支持 GFM 表格、代码块语法高亮（Warm Academic 主题）
  - 提取 `codeTheme.ts` 共享模块，DocumentReader 与 Chat 复用同一套代码主题

## 0.26.0

### Minor Changes

- Sidebar 重构：Pinned / Recent / Import 三组结构 + Algolia 风格 ⌘K 搜索；live sync claude.ai web 聊天记录（Cookies+Keychain 解密 → API 拉取）；Pinned 三态 toggle 与 Claude desktop app starredIds 镜像；SessionItemButton 三点菜单 + 左侧 circle bullet；GlobalHeader 顶 nav 调整 Chat 为第一项；ActivityCard 复用到 Chat 空状态。

## 0.25.1

### Patch Changes

- a9f2fbd: Fix TS build errors blocking v0.25.0 release

  - Export `MaasRegistryView` from `src/views/index.ts`
  - Add `basic-maas` route in `_layout.tsx` and `features.tsx` `Record<FeatureType, string>`
  - Bump tsconfig `target`/`lib` to ES2022 (needed for `Array.at()`)
  - Remove dead `isShortViewport`/`quickActions` + unused icon imports in `PanelGrid`

## 0.25.0

### Minor Changes

- MaaS registry management + events page + workspace consolidation

  - Added MaaS (Model-as-a-Service) provider registry with 4 new Tauri commands (get/save/upsert/delete) for managing custom model providers persistently
  - New `/settings/maas` page with `MaasRegistryView` UI for adding/editing provider entries
  - New `/events` page
  - Extracted LLM provider presets to `LLM_PROVIDER_PRESETS` constant (DRY refactor)
  - Consolidated standalone Home view into `WorkspaceView`

## 0.24.22

### Patch Changes

- d84a524: Chat history search highlighting & navigation

  - Matched search terms are now highlighted in session titles, project names, and message content
  - Session detail header shows match counter (N/M) with up/down buttons to jump between matches
  - Active match scrolls into view and is visually emphasized
  - Works for both plain-text and markdown-rendered messages

## 0.24.21

### Patch Changes

- - Sidebar action bar moved from footer to header
  - Session archive / unarchive, plus bulk "archive this and all after" action
  - Global toggle to show/hide archived sessions (persisted)
  - Virtualized grouped + flat session lists (removed 100-item cap)
  - Fix tooltip overlapping the 3-dot menu trigger in the sidebar
  - PanelGrid Welcome: terminal-type selector moved next to the Create button
  - WorkspaceView: unified Welcome state into PanelGrid

## 0.24.20

### Patch Changes

- Sticky session header with 'Prompts only' filter, hover timestamps, and resilient update-status display

## 0.24.19

### Patch Changes

- Fix skill detail page "not found" error and show update status inline in status bar

## 0.24.18

### Patch Changes

- fix(chat): show full message content by default instead of collapsed 40px
- fix(updater): correct endpoint URL from MarkShawn2020 to lovstudio org

## 0.24.17

### Patch Changes

- Add "Copy Resume Command" menu item and fix project path decoding from session cwd

## 0.24.16

### Patch Changes

- feat(chat): 支持导入 claude.ai 网页端导出的数据包（.zip 或目录）
- feat(chat): 添加数据源切换标签（All/Code/Web）
- fix(chat): 项目列表默认折叠
- fix(nav): 修复启动时导航栏激活状态未与首页同步的问题
- fix: 改进项目路径解码，处理末尾 /. 等边缘情况

## 0.24.15

### Patch Changes

- feat(chat): 会话中显示结构化内容块（工具调用、思考过程、工具结果）

## 0.24.14

### Patch Changes

- 改进全文搜索：使用 jieba 搜索模式提升中文分词召回率，修复重叠 token 偏移计算，自动构建搜索索引

## 0.24.13

### Patch Changes

- feat(ProjectList): 添加会话搜索功能

## 0.24.12

### Patch Changes

- feat(ProjectList): refactor to two-column master-detail layout with grouped/flat toggle

## 0.24.11

### Patch Changes

- 添加应用内自动更新功能

## 0.24.10

### Patch Changes

- fix(GlobalHeader): 导航栏布局优化 + 设置窗口最小尺寸

## 0.24.9

### Patch Changes

- 修复 slash command 菜单交互和布局问题

## 0.24.8

### Patch Changes

- 修复在中文输入法下 shift 键相关的 IME 符号输入问题

## 0.24.7

### Patch Changes

- Add session usage tracking with token counts and cost estimation

## 0.24.6

### Patch Changes

- refactor(settings): Apple style dual-column layout
  feat(statusbar): script-configurable statusbar
  feat(workspace): Dashboard sidebar show/hide toggle
  feat(ui): add bottom statusbar
  fix(knowledge): fix distill detail 404 issue

## 0.24.5

### Patch Changes

- fix(windows): 修复 Windows 平台路径和 shell 兼容性问题

  - 使用 PowerShell 替代 /bin/zsh 进行 shell spawning
  - 使用 taskkill 替代 libc::kill 实现跨平台进程终止

  Fixes #16

## 0.24.4

### Patch Changes

- fix: Windows 平台兼容性 - 使用 cfg 条件编译处理进程取消

## 0.24.3

### Patch Changes

- fix(settings): 简化 npm 安装逻辑并恢复 loadVersionInfo 行为

## 0.24.2

### Patch Changes

- fix(settings): 修复安装后版本检测问题

  - 优先检查 ~/.local/bin/claude (native) 而非依赖 which claude 的 PATH 顺序
  - npm 安装时自动移除 native 二进制，确保检测正确显示 npm 版本

## 0.24.1

### Patch Changes

- 修复 Claude Code 终端无法启动及退出后无法输入的问题

  - PTY 使用 -ilc 参数启动 login shell，确保加载用户环境变量
  - 命令退出后自动回退到默认 shell
  - 默认 shell 从 bash 改为 zsh（macOS 默认）

## 0.24.0

### Minor Changes

- feat: 文件系统路由架构重构

  - 迁移到 vite-plugin-pages 实现文件系统路由
  - Settings 拆分为独立子页面（LLM、环境变量、上下文文件、版本）
  - 统一各 View 组件结构
  - 优化导航侧边栏

## 0.23.8

### Patch Changes

- fix(ts): resolve IME key type comparison error

## 0.23.7

### Patch Changes

- fix: disable autocorrect and context menu in production

## 0.23.6

### Patch Changes

- fix(terminal): 修复 WebGL context 泄漏导致的过多 context 错误

## 0.23.5

### Patch Changes

- perf(terminal): 优化 xterm.js 集成，修复闪烁和宽度问题

## 0.23.4

### Patch Changes

- refactor(dashboard): 项目 Dashboard 从 Features 改为 Sessions 视图

## 0.23.3

### Patch Changes

- 移除侧边栏 Feats 模式，仅保留 Sessions 视图

## 0.23.2

### Patch Changes

- Add multi-shell type support for terminal creation button

## 0.23.1

### Patch Changes

- Add split-button for new terminal with Terminal/Claude Code/Codex options

## 0.23.0

### Minor Changes

- Remove debug logs and improve terminal exit behavior

  - Remove debug logs from pty_manager.rs and TerminalPane.tsx
  - Keep sessions with commands open after PTY exit for scrollback visibility
  - Refactor workspace and panel components

## 0.22.1

### Patch Changes

- fix(chat): sort search results by timestamp descending

## 0.22.0

### Minor Changes

- Add vertical feature tabs sidebar layout option

  - New layout mode: vertical sidebar for project/feature tabs
  - Resizable sidebar width (180-400px, persisted)
  - Project drag-and-drop reordering in vertical mode
  - Toggle in Settings → Display → Project tabs layout
  - Default changed to vertical layout

## 0.21.1

### Patch Changes

- Move CommandTrendChart from Home page to Commands page for better context

## 0.21.0

### Minor Changes

- Add command count stats and improve share card UI for annual report

## 0.20.0

### Minor Changes

- Add PTY data batching and scroll stabilization for smoother terminal rendering

  - Batch PTY writes per animation frame to reduce render frequency
  - Lock scroll position during write to prevent flicker
  - Strip ANSI escape sequences from terminal title
  - Add AnnualReport view and FeaturedCarousel component

## 0.19.0

### Minor Changes

- 新增 Logo 生成与管理面板，优化折叠状态下的 tab group 显示

## 0.18.2

### Patch Changes

- fix(stats): 修复命令统计数据膨胀问题

  - weekly 模式下隐藏当前（不完整）周的数据
  - 过滤 queue-operation 类型的内部日志，避免重复计数
  - 简化 CommandTrendChart 代码，移除不再需要的 \_current 逻辑

## 0.18.1

### Patch Changes

- Fix CommandTrendChart parameters and recharts tooltip styles

## 0.18.0

### Minor Changes

- feat(home): 添加命令趋势图表组件

  - 新增 CommandTrendChart 组件，使用 recharts 展示命令使用趋势
  - 集成到 Home 页面

## 0.17.1

### Patch Changes

- feat(diagnostics): 添加文件行数统计和诊断视图增强

## 0.17.0

### Minor Changes

- 内嵌 claude-code 和 codex 文档作为 submodules

  - 添加 claude-code-docs 和 codex 作为 git submodules
  - 编译后的应用自动包含这两个文档库
  - 用户自定义文档优先于内嵌文档
  - 更新 README 中的 GitHub 仓库地址

## 0.16.0

### Minor Changes

- 50e71ea: Add StatuslineView and marketplace support

  - StatuslineView for editing Claude Code statusline configuration
  - Marketplace directory with statusline templates
  - Enhanced MarkdownRenderer with new capabilities

## 0.15.0

### Minor Changes

- Add provider analytics for LLM provider usage tracking

## 0.14.0

### Minor Changes

- 添加硅基流动 LLM Provider 支持

## 0.13.0

### Minor Changes

- feat: support vibe coding in workspace

## 0.12.3

### Patch Changes

- Fix CI build by removing unused variables

## 0.12.2

### Patch Changes

- Update logo to falcon eye design (v21) - simple geometric eye + tear mark in warm terracotta

## 0.12.1

### Patch Changes

- refactor: 模块化 Settings 和 Chat 视图，优化 Marketplace source filter

## 0.12.0

### Minor Changes

- feat: add vibe coding logo branding

  - New logo design combining code brackets with wave curves
  - Add logo to sidebar footer and welcome page
  - Update all Tauri app icons

## 0.11.5

### Patch Changes

- 修复构建错误：清理悬浮窗功能遗留代码

## 0.11.4

### Patch Changes

- 移除悬浮窗功能

## 0.11.3

### Patch Changes

- 升级所有 icon 为 Radix Icons，统一设计系统

## 0.11.2

### Patch Changes

- fix: 修复 Windows/Linux 编译错误（macOS 专用 API 添加条件编译）

## 0.11.1

### Patch Changes

- fix(macos): 修复 Dock 点击后窗口无法聚焦的问题，使用延迟激活确保窗口显示完成后再聚焦

## 0.11.0

### Minor Changes

- feat(queue): 消息队列支持已完成/待处理切换和虚拟滚动

  - 新增已完成消息队列存储和持久化
  - 新增 dismiss_review_item 和 get_completed_queue 命令
  - 使用 @tanstack/react-virtual 实现虚拟滚动
  - Header 添加 MiniSwitch 切换仅显示待处理或全部消息
  - 使用 Lovcode logo 替换 ClipboardList 图标

## 0.10.0

### Minor Changes

- feat(queue): 添加全局自增序号并优化消息列表显示
  fix(queue): 消息队列按终端标识去重

## 0.9.0

### Minor Changes

- 新增悬浮窗功能、设置增强、命令管理改进

## 0.8.0

### Minor Changes

- commands: 支持重命名/aliases/智能 placeholder
  distill: 支持可选 session + source 渠道标记
  fix: usePersistedState JSON 解析异常

## 0.7.0

### Minor Changes

- ### Features

  - feat(distill): 添加目录监听自动刷新与 UI 优化
  - feat(chats): 实现虚拟无限滚动加载
  - feat(distill): 支持从 distill 跳转到 session

  ### Performance

  - perf: 优化 History 页面性能，避免 IO 阻塞 UI

  ### Fixes

  - fix(export): 修复导出对话框按钮被隐藏的问题
  - fix(distill): 修复打开文件路径解析错误

  ### Style

  - style(sidebar): 优化 Knowledge 子菜单选中状态的视觉层次
  - style(theme): 集成 Lovstudio 暖学术设计系统

  ### Refactor

  - refactor(session): 使用下拉菜单优化 SessionDetail 工具栏

## 0.6.2

### Patch Changes

- fix(search): 修复中文搜索无法匹配的问题

  - 实现 JiebaTokenizer 自定义分词器支持中文分词
  - 为 content 和 session_summary 字段配置 jieba 分词器

## 0.6.1

### Patch Changes

- fix: add Cargo.toml version sync for correct binary versioning

## 0.6.0

### Minor Changes

- 新增 Sessions 和 Chats tab 及全文搜索功能

  - History 页面支持三种视图切换：Projects（按项目分组）、Sessions（扁平列表）、Chats（所有消息）
  - 集成 Tantivy 搜索引擎，支持消息内容实时搜索
  - 各 tab 独立懒加载，切换时保持缓存
  - Chats 显示已加载/总计消息数

## 0.5.2

### Patch Changes

- 8103989: fix: sync Tauri version from package.json to ensure consistent artifact naming

## 0.5.1

### Patch Changes

- 85d0e82: fix: update submodule reference to valid commit

## 0.5.0

### Minor Changes

- d85a5a3: 新增 Commands 使用统计功能：从 session 历史中提取 slash command 调用次数，支持按使用量/名称排序

## [0.4.0] - 2025-12-17

- 新增会话原文件快速打开功能（Reveal in Finder）
- 新增 Clean 模式过滤中间过程消息
- 优化选择模式，支持快速选择全部/仅用户消息
- 导出支持精简 Bullet 格式
- 新增水印选项

## [0.3.5] - 2025-12-17

- 修复 MCP 配置文件路径（现正确使用 ~/.claude.json）
- MCP 页面新增快速打开配置文件按钮

## [0.3.4] - 2025-12-17

- 修复打包后 Marketplace 模板无法加载的问题

## [0.3.3] - 2025-12-16

- 优化首页标语文案

## [0.3.2] - 2025-12-16

- 调整开发环境配置

## [0.3.1] - 2025-12-16

- 修复顶栏拖拽移动窗口功能

## [0.3.0] - 2025-12-15

- 新增会话多选导出功能
- 支持导出为 Markdown 格式，含目录和元信息
- 支持项目级别批量导出多个会话

## [0.2.0] - 2025-12-10

- 新增用户头像和个人资料设置
- 支持本地上传头像图片
- 个人资料自动保存

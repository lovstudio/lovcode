# Changelog

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

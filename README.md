<p align="center">
  <img src="docs/images/cover.png" alt="Lovcode Cover" width="100%">
</p>

<h1 align="center">
  <img src="assets/logo.svg" width="32" height="32" alt="Logo" align="top">
  Lovcode
</h1>

<p align="center">
  <strong>Desktop companion for AI coding tools</strong><br>
  <sub>macOS • Windows • Linux</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri-2.0-blue" alt="Tauri">
  <img src="https://img.shields.io/badge/React-19-blue" alt="React">
  <img src="https://img.shields.io/badge/TypeScript-5.8-blue" alt="TypeScript">
  <img src="https://img.shields.io/badge/License-Apache_2.0-green" alt="License">
</p>

---

<p align="center">
  <a href="#features">Features</a> •
  <a href="#oh-my-lovcode">oh-my-lovcode</a> •
  <a href="#installation">Installation</a> •
  <a href="#usage">Usage</a> •
  <a href="#tech-stack">Tech Stack</a> •
  <a href="#license">License</a>
</p>

---

![Gallery](docs/assets/gallery.png)

## Features

- **Chat History Viewer** — Browse and search conversation history across all projects with full-text search (Chinese + English)
- **Claude.ai Import** — Import and view exported data from claude.ai web app (.zip or directory)
- **Data Source Switching** — Filter between Claude Code local sessions and claude.ai web conversations
- **Structured Content Blocks** — View tool calls, thinking process, and tool results in conversations
- **Commands Manager** — View and manage slash commands (`~/.claude/commands/`)
- **MCP Servers** — Configure and monitor MCP server integrations
- **Skills** — Manage reusable skill templates
- **Hooks** — Configure automation triggers
- **Sub-Agents** — Manage AI agents with custom models
- **Output Styles** — Customize response formatting
- **Marketplace** — Browse and install community templates
- **Customizable Statusbar** — Personalize your statusbar display with scripts

## oh-my-lovcode

Community configuration framework for Lovcode, inspired by oh-my-zsh.

```bash
curl -fsSL https://raw.githubusercontent.com/MarkShawn2020/oh-my-lovcode/main/install.sh | bash
```

Share and discover statusbar themes, keybindings, and more at [oh-my-lovcode](https://github.com/MarkShawn2020/oh-my-lovcode).

## Installation

### From Release

Download the latest release for your platform from [Releases](https://github.com/markshawn2020/lovcode/releases).

### From Source

```bash
# Clone the repository (with submodules)
git clone --recursive https://github.com/markshawn2020/lovcode.git
cd lovcode

# Install dependencies
pnpm install

# Run development
pnpm tauri dev

# Build for distribution
pnpm tauri build
```

## Usage

1. Launch Lovcode
2. Select **Chat** to browse conversation history from Claude Code sessions
3. Click the **Upload** button to import claude.ai exported data (.zip or folder)
4. Switch between **All / Code / Web** tabs to filter by data source
5. Use the **Configuration** section to manage commands, MCP servers, skills, and hooks
6. Visit **Marketplace** to discover community templates

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, TypeScript, Tailwind CSS, Vite |
| Backend | Rust, Tauri 2 |
| UI Components | shadcn/ui |
| State | Jotai |
| Search | Tantivy + jieba (full-text, Chinese-aware) |

## Release Highlights

| Version | Highlights |
|---------|------------|
| **0.24.16** | Import claude.ai web exports (.zip/dir), data source tabs (All/Code/Web) |
| **0.24.15** | Structured content blocks — view tool calls, thinking, tool results |
| **0.24.14** | Full-text search with jieba Chinese tokenization |
| **0.24.12** | Two-column master-detail layout with grouped/flat toggle |
| **0.24.11** | In-app auto-updater |
| **0.24.7** | Session usage tracking with token counts and cost estimation |
| **0.24.6** | Script-configurable statusbar, Apple-style settings layout |
| **0.24.0** | File-system routing architecture, settings split into sub-pages |

[Full Changelog](CHANGELOG.md)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=markshawn2020/lovcode&type=Date)](https://star-history.com/#markshawn2020/lovcode&Date)

## License

Apache-2.0

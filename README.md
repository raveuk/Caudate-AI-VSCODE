# Caudate IDE

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/raveuk/Caudate-AI-VSCODE/blob/main/LICENSE.txt)
[![Version](https://img.shields.io/badge/Caudate_IDE-v1.0.0-0969da.svg)](https://github.com/raveuk/Caudate-AI-VSCODE/releases)
[![Caudate AI](https://img.shields.io/badge/Caudate_AI-v2.0.0-2ea043.svg)](https://github.com/raveuk/Caudate-AI-VSCODE)
[![Issues](https://img.shields.io/github/issues/raveuk/Caudate-AI-VSCODE)](https://github.com/raveuk/Caudate-AI-VSCODE/issues)

**Caudate IDE** is an AI-native desktop code editor built as a full **VS Code (Code - OSS) fork** — developed by **Rave Manji**.

It combines the autonomous multi-agent workflows of **Antigravity IDE** and the inline editing speed of **Cursor** — with complete freedom to run **local models (Ollama, LM Studio)** or **any OpenAI-compatible API** (OpenAI, OpenRouter, DeepSeek, Groq, vLLM) with **zero mandatory sign-in or vendor lock-in**.

---

## Features

### Editor & Inline AI
- **Inline Edit (`Ctrl+K`) with Per-Hunk Controls**: Edit selected code or generate at the cursor with line-level diff highlights and individual **Accept Hunk / Reject Hunk** CodeLens actions plus **Accept All (`Ctrl+Enter`) / Reject All (`Esc`) / Retry**.
- **Tab Ghost-Text Autocomplete**: Native Ollama Fill-in-the-Middle (FIM) and universal chat fallback with LRU caching and a dedicated **Tab Settings** status bar menu.
- **Next Edit Prediction (NES)**: Tracks recent edits and suggests nearby multi-line follow-up edits and jumps — press **`Tab`** to jump & apply, **`Esc`** to dismiss.
- **Quick Fix with Caudate AI (`Ctrl+.`)**: Lightbulb fixes directly on compiler, linter, and TypeScript errors.
- **Terminal Inline (`Ctrl+K` in Terminal)**: Generate PowerShell or bash commands from plain English and insert or run them straight in the integrated terminal.

### Autonomous Agent & Multi-Agent Workflows
- **Agent / Ask / Plan Modes**: Autonomous tool-calling loop (`read_file`, `write_file`, `edit_file`, `list_dir`, `search_files`, `get_diagnostics`, `run_terminal_command`) with live streaming terminal output.
- **Interactive Implementation Plan Artifacts**: `Plan` mode and `/plan` produce structured plans with one-click **Approve & Execute** and **Open MD**.
- **Multi-File Review Bar & Turn Checkpoints**: Native side-by-side diffs, per-file revert, turn checkpoints, and a sticky review bar (**Review Next**, **Keep All**, **Undo All**).
- **Parallel Git Worktree Agents (`⎇` Drawer / `/worktree`)**: Run multiple autonomous agents simultaneously in isolated git branches and worktrees, open them, merge finished branches, or discard cleanly.
- **Built-in Browser Agent**: Headless Chrome/Edge DevTools tools (`browser_navigate`, `browser_click`, `browser_type`, `browser_evaluate`, `browser_screenshot`) with console/network error capture and inline screenshots in chat.

### Context, Vision, Rules & Memory
- **Semantic Vector Codebase Indexing**: Local or cloud embeddings (`nomic-embed-text`, LM Studio, or OpenAI embeddings) with cached incremental indexing and hybrid lexical fallback.
- **Extended `@` Mentions**: `@file`, `@folder`, `@codebase`, `@problems`, `@git`, `@terminal`, `@symbols`, `@web`, `@docs`, and `@notepad`.
- **Vision / Screenshot Input**: Paste (`Ctrl+V`) or attach (`🖼`) screenshots and UI mockups for vision-capable models.
- **Scoped Rules, Skills & Slash Commands**: Loads `.caudaterules`, `.caudate/rules/*.md`, `.cursorrules`, `.aether/skills/*/SKILL.md`, Notepads (`📝`), and `/fix`, `/test`, `/review`, `/plan`, `/compact`, `/index`, `/worktree`.
- **Token Budget Meter & Auto-Compaction**: Live token counter with one-click **Compact** history summarization.

### MCP, Git & Security
- **MCP (Model Context Protocol) Client**: Connect external `stdio` and `HTTP/SSE` MCP servers via `.caudate/mcp.json` or `~/.caudate-ide/mcp.json`.
- **AI Git Suite**: Source Control commit message generator, AI diff code review, and inline **Resolve Conflict with Caudate AI** CodeLens.
- **Privacy & Secret Protection**: Automatically blocks `.env`, `*.key`, `*.pem`, credentials, and `.caudateignore` / `.cursorignore` files, stores API keys in OS `SecretStorage`, and enforces configurable command allowlists/denylists.
- **Open VSX Extensions Marketplace**: Install VS Code extensions directly from the Extensions panel.

---

## Quick Start

### Clone & Build from Source (Windows)
Prerequisites: **Node.js 24**, **pnpm 12**, **Python 3**, and **Visual Studio 2022** (*Desktop development with C++*).

```powershell
git clone https://github.com/raveuk/Caudate-AI-VSCODE.git
cd Caudate-AI-VSCODE

$env:VSCODE_SKIP_NODE_VERSION_CHECK="1"
pnpm install
pnpm run build-fast
pnpm run electron
```

### Launch Caudate IDE
```powershell
.\launch-caudate.bat
```
Or install Desktop & Start Menu shortcuts and the `caudate` CLI command on `PATH`:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-caudate-desktop.ps1
caudate .
```

### Build Standalone Windows Package
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-production.ps1
```

---

## Keyboard Shortcuts
| Shortcut | Action |
| --- | --- |
| `Ctrl+L` | Open / Focus Caudate AI Agent |
| `Ctrl+I` | Open Caudate Agent Composer |
| `Ctrl+K` (Editor) | Inline Edit at cursor / selection |
| `Ctrl+K` (Terminal) | Terminal Inline command generator |
| `Ctrl+Enter` | Accept pending Inline Edit |
| `Esc` | Reject pending Inline Edit / dismiss NES |
| `Tab` | Accept Ghost-Text Autocomplete or Next Edit Prediction |
| `Ctrl+.` | Quick Fix with Caudate AI on diagnostics |

---

## Issue Reporting & Feature Requests
- **Report a Bug**: [Open a GitHub Issue](https://github.com/raveuk/Caudate-AI-VSCODE/issues/new) (also wired directly to **Help → Report Issue** inside Caudate IDE)
- **Releases & Downloads**: [GitHub Releases](https://github.com/raveuk/Caudate-AI-VSCODE/releases)

---

## Developer & License

- **Developer**: **Rave Manji** ([@raveuk](https://github.com/raveuk))
- **Repository**: [github.com/raveuk/Caudate-AI-VSCODE](https://github.com/raveuk/Caudate-AI-VSCODE)
- **License**: **MIT License** — see [LICENSE.txt](LICENSE.txt).
- **Attribution**: Caudate IDE is based on **Visual Studio Code (Code - OSS)** by Microsoft Corporation, licensed under the MIT License.

### Who Can Use Caudate IDE?
Under the **MIT License**:
- **Individuals, students, open-source contributors, startups, and enterprises** can freely **use, copy, modify, merge, publish, distribute, sublicense, and sell** Caudate IDE for **personal, academic, or commercial** purposes.
- **Conditions**: Keep the copyright notice (`Copyright (c) 2026 Rave Manji` and `Microsoft Corporation`) and the MIT permission notice in copies or substantial portions of the software.
- **Warranty**: Provided *"AS IS"*, without warranty of any kind.

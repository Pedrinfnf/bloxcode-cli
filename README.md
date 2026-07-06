# bloxcode

AI coding agent for the terminal. Rust TUI + TypeScript backend.

```
 ● bloxcode · nemotron-ultra-550b
─────────────────────────────────────
you  /
 ┌─ commands ────────────────────┐
 │ ▸ /help     Show commands     │
 │   /model    Switch model      │
 │   /agent    Multi-agent       │
 │   /tools    List tools        │
 └───────────────────────────────┘
 > /
─────────────────────────────────────
 /commands · @file · !shell  ready
```

## Install

**One-liner (auto-detects platform):**
```bash
curl -fsSL https://raw.githubusercontent.com/Pedrinfnf/bloxcode-cli/main/install.sh | bash
```

**Termux:**
```bash
curl -fsSL https://raw.githubusercontent.com/Pedrinfnf/bloxcode-cli/main/install.sh | bash
bloxcode
```

**Or with npm (TypeScript mode, no Rust TUI):**
```bash
npm install -g github:Pedrinfnf/bloxcode-cli
bloxcode
```

## Setup

```
/api set sk-or-v1-your-key
```

Free key at [openrouter.ai/keys](https://openrouter.ai/keys)

## Features

- **Rust TUI** — real terminal UI with ratatui (raw mode, panels, menus)
- **Command palette** — type `/` and navigate with ↑↓
- **Smart streaming** — text streams live, JSON buffered silently
- **20+ tools** — files, shell, git, web, docker
- **5 sub-agents** — Coder, Reviewer, Researcher, Tester, DevOps
- **MCP** — connect external tool servers
- **@file** attach, **!cmd** shell shortcuts
- **Mobile-first** — built for Termux

## Architecture

```
[Terminal Screen]
       ↕
[Rust TUI — ratatui, crossterm]  ← raw mode, rendering, input
       ↕ JSON over stdio
[TypeScript Agent]  ← LLM streaming, tools, MCP, agents
```

This is the same architecture as Codex CLI (Rust + JS).

## Commands

```
/help          Show commands       /model <slug>   Set model
/api set <key> Set API key         /mode <m>       Change mode
/agent <task>  Multi-agent         /tools          List tools
/mcp add       Add MCP server      /clear          Clear context
@file msg      Attach file         !command        Shell
```

## Build from source

```bash
git clone https://github.com/Pedrinfnf/bloxcode-cli
cd bloxcode-cli/tui
cargo build --release
./target/release/bloxcode
```

## License

MIT

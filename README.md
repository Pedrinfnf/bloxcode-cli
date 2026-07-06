# bloxcode

AI coding agent for the terminal. Built for Termux.

```
  ● bloxcode
  v0.1.0 · nemotron-3-ultra-550b-a55b:free · suggest
  ~/my-project

  /help · /model · @file · !cmd · /agent
```

## Install

```bash
npm install -g github:Pedrinfnf/bloxcode-cli
```

## Setup

```bash
bloxcode
# then:
/api set sk-or-v1-your-key-here
```

Get a free key at [openrouter.ai/keys](https://openrouter.ai/keys)

## Features

- Smart streaming (text live, JSON silent)
- 20+ built-in tools (files, shell, git, web)
- 5 sub-agents (Coder, Reviewer, Researcher, Tester, DevOps)
- MCP server support
- @file references, !shell shortcuts
- Multi-step tool chains (up to 25)
- Mobile-first (built for Termux)

## Commands

```
/api set <key>       Set API key
/model <slug>        Set model
/agent <task>        Multi-agent
/tools               List tools
/mcp add <n> <cmd>   Add MCP server
@file.ts msg         Attach file
!command             Shell
/help                All commands
```

## License

MIT

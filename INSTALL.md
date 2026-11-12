# Install on Windows + WSL

Run every command in the WSL (Ubuntu) terminal, not in PowerShell. Verified on a clean Ubuntu 24.04.

## 1. Node 24 and pnpm

The Ubuntu package is too old (archgraph runs TypeScript directly and needs Node 24+).

```sh
cd ~ && curl -fsSL https://nodejs.org/dist/v24.22.0/node-v24.22.0-linux-x64.tar.xz | tar -xJ
echo 'export PATH=~/node-v24.22.0-linux-x64/bin:$PATH' >> ~/.bashrc && source ~/.bashrc
corepack enable          # pnpm comes from package.json
node -v                  # v24.22.0
```

## 2. Get and build archgraph

The repo is private: `gh auth login` first (or clone over HTTPS with a token).

```sh
gh repo clone kamenvlahov/archgraph ~/archgraph
cd ~/archgraph && pnpm install && pnpm vscode
```

## 3. VS Code extension

VS Code on Windows runs extensions for a WSL folder inside WSL, in `~/.vscode-server/extensions`. Link the folder (do not copy: the extension finds the engine through the repo).

```sh
mkdir -p ~/.vscode-server/extensions
ln -s ~/archgraph/apps/vscode ~/.vscode-server/extensions/kamen.archgraph-vscode-0.0.1
```

VS Code may not see the PATH from `~/.bashrc`, so point it at Node in the user settings (JSON):

```json
"archgraph.node": "/home/<user>/node-v24.22.0-linux-x64/bin/node"
```

Open the project from WSL with `code .`, run **Developer: Reload Window**, then **archgraph: Покажи процеса**.

## 4. MCP for Claude Code

```sh
claude mcp add archgraph -s user -- ~/node-v24.22.0-linux-x64/bin/node ~/archgraph/apps/mcp/src/main.ts
```

## Update

```sh
cd ~/archgraph && git pull && pnpm install && pnpm vscode
```

Then Reload Window in VS Code and `/mcp` reconnect in Claude Code.

# archgraph в контейнер: не зависи от Node-а на машината и не я замърсява.
#   docker build -t archgraph .
#   docker run --rm --init -v "$PWD:$PWD" -p 127.0.0.1:8790:8790 archgraph serve "$PWD" --host 0.0.0.0
#   docker run -i --rm --init -v "$PWD:$PWD" -w "$PWD" archgraph mcp
FROM node:24.22.0-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm ui
# mcp → MCP сървърът, всичко друго → CLI-ът (scan, plan, serve)
COPY <<'SH' /usr/local/bin/archgraph
#!/bin/sh
if [ "$1" = mcp ]; then shift; exec node /app/apps/mcp/src/main.ts "$@"; fi
exec node /app/packages/cli/src/main.ts "$@"
SH
RUN chmod 755 /usr/local/bin/archgraph
ENTRYPOINT ["archgraph"]

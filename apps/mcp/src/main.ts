#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { Server } from './server.ts';

// archgraph-mcp [--scip]: stdio MCP сървър. stdout е само за протокола, всичко друго отива в stderr.
// SCIP е изключен по подразбиране: на голям проект първото сканиране с него е минута.
const { values } = parseArgs({ options: { scip: { type: 'boolean' } } });
const server = new Server({ cwd: process.cwd(), scip: values.scip ?? false });

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'невалиден JSON' } })}\n`,
    );
    continue;
  }
  // Заявките се обработват паралелно, отговорите носят id-то си.
  void server.handle(message).then((reply) => {
    if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
}

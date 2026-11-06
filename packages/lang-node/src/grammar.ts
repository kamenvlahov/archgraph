import { fileURLToPath } from 'node:url';
import { createParser, type Parser } from '@archgraph/syntax';

let parser: Promise<Parser> | undefined;

export function typescriptParser(): Promise<Parser> {
  parser ??= createParser(fileURLToPath(import.meta.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm')));
  return parser;
}

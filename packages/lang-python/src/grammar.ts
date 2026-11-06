import { fileURLToPath } from 'node:url';
import { createParser, type Parser } from '@archgraph/syntax';

let parser: Promise<Parser> | undefined;

export function pythonParser(): Promise<Parser> {
  parser ??= createParser(fileURLToPath(import.meta.resolve('tree-sitter-python/tree-sitter-python.wasm')));
  return parser;
}

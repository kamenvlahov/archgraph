import { fileURLToPath } from 'node:url';
import { createParser, type Parser } from '@archgraph/syntax';

let parser: Promise<Parser> | undefined;

export function goParser(): Promise<Parser> {
  parser ??= createParser(fileURLToPath(import.meta.resolve('tree-sitter-go/tree-sitter-go.wasm')));
  return parser;
}

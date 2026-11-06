import { fileURLToPath } from 'node:url';
import { createParser, type Parser } from '@archgraph/syntax';

let parser: Promise<Parser> | undefined;

export function phpParser(): Promise<Parser> {
  parser ??= createParser(fileURLToPath(import.meta.resolve('tree-sitter-php/tree-sitter-php.wasm')));
  return parser;
}

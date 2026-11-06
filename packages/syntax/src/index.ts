import { Language, Parser, type Node, type Tree } from 'web-tree-sitter';

export type { Node, Parser, Point, Tree } from 'web-tree-sitter';

let ready: Promise<void> | undefined;

// Зарежда граматика от .wasm файл. web-tree-sitter се инициализира веднъж на процес.
export async function createParser(wasmPath: string): Promise<Parser> {
  ready ??= Parser.init();
  await ready;
  return new Parser().setLanguage(await Language.load(wasmPath));
}

export function parse(parser: Parser, text: string): Tree {
  const tree = parser.parse(text);
  if (!tree) throw new Error('tree-sitter не върна дърво (няма зададена граматика?)');
  return tree;
}

export interface SyntaxError {
  line: number;
  text: string;
}

// Местата, които парсерът не е разбрал (ERROR или липсващ възел). Редовете са от 1.
export function syntaxErrors(tree: Tree): SyntaxError[] {
  const errors: SyntaxError[] = [];
  const walk = (node: Node) => {
    if (!node.hasError && !node.isMissing) return;
    if (node.isError || node.isMissing) {
      errors.push({
        line: node.startPosition.row + 1,
        text: node.isMissing ? `липсва ${node.type}` : node.text.slice(0, 60),
      });
      return;
    }
    node.children.forEach(walk);
  };
  walk(tree.rootNode);
  return errors;
}

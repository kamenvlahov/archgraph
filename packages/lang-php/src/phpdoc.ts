import type { Field, TypeRef } from '@archgraph/model';

// PHPDoc типове (phpstan/psalm синтаксис): list<X>, array<K, V>, array{a: T, b?: T}, X[], ?X, A|B, Collection<X>.
// `named` превръща име на клас в TypeRef; резолюцията по namespace/use е на адаптера.

export interface DocComment {
  params: Map<string, string>;
  return?: string;
}

export function parseDocComment(text: string): DocComment {
  const body = text
    .replace(/^\/\*\*|\*\/$/g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
  const doc: DocComment = { params: new Map() };
  for (const match of body.matchAll(/@(param|return)\s+/g)) {
    const start = (match.index ?? 0) + match[0].length;
    const raw = takeType(body, start);
    // `@return string;` и `@param string &$x` се срещат в стар код.
    const type = raw.replace(/;$/, '').replace(/^&/, '');
    if (!type) continue;
    if (match[1] === 'return') {
      doc.return = type;
      continue;
    }
    const name = /^\s*&?(?:\.\.\.)?&?\$(\w+)/.exec(body.slice(start + raw.length));
    if (name?.[1]) doc.params.set(name[1], type);
  }
  return doc;
}

// Типът свършва на първия интервал извън скоби: `array{a: int, b: string} $x`.
function takeType(text: string, start: number): string {
  let depth = 0;
  let i = start;
  for (; i < text.length; i++) {
    const c = text.charAt(i);
    if ('<{('.includes(c)) depth++;
    else if ('>})'.includes(c)) depth--;
    else if (/\s/.test(c) && depth === 0) break;
  }
  return text.slice(start, i);
}

const PRIMITIVES = new Set([
  'int',
  'integer',
  'float',
  'double',
  'string',
  'bool',
  'boolean',
  'array',
  'mixed',
  'void',
  'null',
  'iterable',
  'callable',
  'object',
  'never',
  'false',
  'true',
  'scalar',
  'resource',
]);

export function isPrimitive(name: string): boolean {
  const lower = name.toLowerCase();
  // non-empty-string, positive-int, class-string...
  return PRIMITIVES.has(lower) || /^[a-z]+(-[a-z]+)+$/.test(lower);
}

export function parseDocType(text: string, named: (name: string, args?: TypeRef[]) => TypeRef): TypeRef {
  const tokens = text.match(/\$this|\\?[A-Za-z_][\w\\-]*|\.\.\.|[<>{}()[\],:?|]|'[^']*'|"[^"]*"|\S/g) ?? [];
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (t: string) => {
    if (next() !== t) throw new Error(`очаквах "${t}" в "${text}"`);
  };

  const union = (): TypeRef => {
    const parts = [postfix()];
    while (peek() === '|') {
      next();
      parts.push(postfix());
    }
    return parts.length === 1 ? (parts[0] as TypeRef) : { kind: 'union', of: parts };
  };

  const postfix = (): TypeRef => {
    let t = atom();
    while (peek() === '[' && tokens[pos + 1] === ']') {
      pos += 2;
      t = { kind: 'array', of: t };
    }
    return t;
  };

  const atom = (): TypeRef => {
    const tok = next();
    if (tok === undefined) throw new Error(`непълен тип "${text}"`);
    if (tok === '?') return { kind: 'union', of: [atom(), { kind: 'primitive', name: 'null' }] };
    if (tok === '(') {
      const t = union();
      expect(')');
      return t;
    }
    if (tok === '$this') return named(tok);
    if (!/^\\?[A-Za-z_]/.test(tok)) throw new Error(`неочакван "${tok}" в "${text}"`);
    const lower = tok.toLowerCase();
    if (peek() === '{') return shape();
    const args = peek() === '<' ? generics() : [];
    if (['array', 'non-empty-array', 'iterable'].includes(lower) && args.length > 0) {
      const [first, second] = args as [TypeRef, TypeRef?];
      return second ? { kind: 'map', key: first, value: second } : { kind: 'array', of: first };
    }
    if (['list', 'non-empty-list'].includes(lower) && args[0]) return { kind: 'array', of: args[0] };
    if (isPrimitive(tok)) return { kind: 'primitive', name: lower };
    return named(tok, args.length > 0 ? args : undefined);
  };

  const generics = (): TypeRef[] => {
    expect('<');
    const args = [union()];
    while (peek() === ',') {
      next();
      args.push(union());
    }
    expect('>');
    return args;
  };

  const shape = (): TypeRef => {
    expect('{');
    const fields: Field[] = [];
    while (peek() !== '}') {
      const name = (next() ?? '').replace(/^['"]|['"]$/g, '');
      const optional = peek() === '?';
      if (optional) next();
      expect(':');
      fields.push(optional ? { name, type: union(), optional } : { name, type: union() });
      if (peek() === ',') next();
    }
    expect('}');
    return { kind: 'shape', fields };
  };

  try {
    const t = union();
    if (pos < tokens.length) throw new Error(`излишно след типа в "${text}"`);
    return t;
  } catch {
    return { kind: 'unknown', hint: text };
  }
}

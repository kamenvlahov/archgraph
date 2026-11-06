// Видовете нодове, ребра и езици не са затворен списък (D-007).
// Тук е ядрото. Адаптерите и разширенията (шаблони, събития, таблици...) добавят свои.

export const CORE_LANGUAGES = ['php', 'node', 'python'];
export const CORE_NODE_KINDS = ['class', 'interface', 'trait', 'enum', 'function', 'module', 'route'];
export const CORE_EDGE_KINDS = [
  'implements',
  'extends',
  'injects',
  'calls',
  'creates',
  'routes-to',
  'returns',
  'uses-type',
  'binds',
];

export interface Registry {
  languages: ReadonlySet<string>;
  nodeKinds: ReadonlySet<string>;
  edgeKinds: ReadonlySet<string>;
}

export interface Extension {
  name: string;
  languages?: string[];
  nodeKinds?: string[];
  edgeKinds?: string[];
}

export const CORE_REGISTRY: Registry = {
  languages: new Set(CORE_LANGUAGES),
  nodeKinds: new Set(CORE_NODE_KINDS),
  edgeKinds: new Set(CORE_EDGE_KINDS),
};

export const KIND_NAME = /^[a-z][a-z0-9-]*$/;

// Две разширения с едно и също име на вид са грешка, а не тихо сливане:
// иначе едното би рисувало и валидирало чуждите нодове.
export function extendRegistry(base: Registry, ext: Extension): Registry {
  const add = (current: ReadonlySet<string>, values: string[] = [], what: string) => {
    const next = new Set(current);
    for (const v of values) {
      if (!KIND_NAME.test(v)) throw new Error(`${ext.name}: невалидно име на ${what} "${v}"`);
      if (next.has(v)) throw new Error(`${ext.name}: ${what} "${v}" вече е регистриран`);
      next.add(v);
    }
    return next;
  };
  return {
    languages: add(base.languages, ext.languages, 'език'),
    nodeKinds: add(base.nodeKinds, ext.nodeKinds, 'вид нод'),
    edgeKinds: add(base.edgeKinds, ext.edgeKinds, 'вид ребро'),
  };
}

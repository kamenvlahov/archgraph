import { edge, type Annotation, type Arg, type Edge, type Node } from '@archgraph/model';
import type { FrameworkRules } from './frameworks.ts';

// Регистрацията на услуги (D-008) от масивите в конфигурацията:
// - речник ключ → клас за `$sm->get('OrderMap')` и `$container->get(X::class)`;
// - `binds` от интерфейса към имплементацията, когато alias-ът свързва два класа от проекта,
//   с `location` към реда на регистрацията.
export function services(
  annotations: Annotation[],
  frameworks: FrameworkRules[],
  nodes: Node[],
): { services: Map<string, string>; edges: Edge[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const found = new Map<string, string>();
  const aliases: { key: string; target: string; line: number; file: string; language: string }[] = [];
  const edges: Edge[] = [];
  for (const fw of frameworks) {
    const rules = fw.services;
    if (!rules) continue;
    const classOf = (a: Arg): string | undefined => {
      if (a.kind === 'class') return a.id;
      if (a.kind === 'string' && /^\\?[A-Za-z_][\w\\]*\\[A-Za-z_]\w*$/.test(a.value))
        return `${fw.language}:${a.value.replace(/^\\/, '')}`;
      return undefined;
    };
    for (const a of annotations) {
      if (a.kind !== 'object' || !a.key) continue;
      for (const entry of a.args) {
        const key = entry.name ?? '';
        if (rules.invokables.includes(a.key)) {
          const id = classOf(entry);
          if (id) found.set(key, id);
        } else if (rules.factories.includes(a.key)) {
          // фабриката прави услуга с името на ключа, когато ключът е клас (`X::class => XFactory::class`)
          if (byId.has(key)) found.set(key, key);
        } else if (rules.aliases.includes(a.key)) {
          const target = entry.kind === 'string' ? entry.value : entry.kind === 'class' ? entry.id : undefined;
          if (target)
            aliases.push({
              key,
              target,
              line: entry.line ?? a.location.line,
              file: a.location.file,
              language: fw.language,
            });
        }
      }
    }
  }
  // Alias сочи към друг ключ или клас; веригата се следва няколко стъпки.
  for (const al of aliases) {
    let target = al.target;
    for (let i = 0; i < 5 && found.has(target) && found.get(target) !== target; i++)
      target = found.get(target) ?? target;
    const id = byId.has(target)
      ? target
      : (found.get(target) ?? (target.includes('\\') ? `${al.language}:${target.replace(/^\\/, '')}` : undefined));
    if (!id) continue;
    found.set(al.key, id);
    if (byId.has(al.key) && al.key !== id)
      edges.push({
        ...edge('binds', { node: al.key }, { node: id }),
        location: { file: al.file, line: al.line, endLine: al.line },
      });
  }
  return { services: found, edges };
}

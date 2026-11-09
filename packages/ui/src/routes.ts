// Ендпойнтите като дърво по пътя: общото начало (`admin › profile`) е група, в нея са краищата
// (`/`, `edit`, `view`). Верига от групи с по една подгрупа се слива в една, а група с един път
// се разгъва в родителя, за да няма папки ради един ред.

export interface Leaf<T> {
  name: string; // остатъкът от пътя след групата; `/` е самият път на групата
  entry: T;
}

export interface RouteGroup<T> {
  key: string; // пълният път на групата
  crumbs: string[];
  leaves: Leaf<T>[];
  groups: RouteGroup<T>[];
  count: number;
}

interface Trie<T> {
  here: T[];
  children: Map<string, Trie<T>>;
}

export function routeTree<T extends { label: string }>(entries: T[]): RouteGroup<T> {
  const root: Trie<T> = { here: [], children: new Map() };
  const other: Leaf<T>[] = [];
  for (const entry of entries) {
    const path = entry.label.split(' ').slice(1).join(' ');
    if (!path.startsWith('/')) {
      other.push({ name: entry.label, entry });
      continue;
    }
    let node = root;
    for (const seg of path.split('/').filter(Boolean)) {
      const next = node.children.get(seg) ?? { here: [], children: new Map() };
      node.children.set(seg, next);
      node = next;
    }
    node.here.push(entry);
  }
  const tree = build(root, '', []);
  tree.leaves.push(...other);
  tree.count += other.length;
  return tree;
}

function build<T>(node: Trie<T>, key: string, crumbs: string[]): RouteGroup<T> {
  const group: RouteGroup<T> = {
    key,
    crumbs,
    leaves: node.here.map((entry) => ({ name: '/', entry })),
    groups: [],
    count: node.here.length,
  };
  for (const [seg, child] of [...node.children].sort(([a], [b]) => a.localeCompare(b))) {
    let sub = build(child, `${key}/${seg}`, [seg]);
    while (!sub.leaves.length && sub.groups.length === 1) {
      const only = sub.groups[0] as RouteGroup<T>;
      sub = { ...only, crumbs: [...sub.crumbs, ...only.crumbs] };
    }
    group.count += sub.count;
    // група има смисъл при поне два различни пътя (GET и POST на един път са два реда)
    if (sub.count > 1 && (sub.groups.length || sub.leaves.some((l) => l.name !== '/'))) group.groups.push(sub);
    else group.leaves.push(...flatten(sub, sub.crumbs.join('/')));
  }
  return group;
}

// Ендпойнтите на група като редове в родителя: името им получава пътя на групата отпред.
function flatten<T>(group: RouteGroup<T>, prefix: string): Leaf<T>[] {
  return [
    ...group.leaves.map((l) => ({ ...l, name: l.name === '/' ? prefix : `${prefix}/${l.name}` })),
    ...group.groups.flatMap((g) => flatten(g, `${prefix}/${g.crumbs.join('/')}`)),
  ];
}

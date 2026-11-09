import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Node } from '@archgraph/model';
import type { Condition } from './frameworks.ts';
import { matches, type RoleFacts } from './roles.ts';

// Архитектурата на проекта (D-009, `.archgraph/architecture.yaml`): слоеве с условия, позволени посоки
// между тях и контексти (модули). Без файла слоят идва от каталога на ролите.

export interface Architecture {
  style: string;
  layers: { name: string; match: Condition }[]; // отвън навътре; първото съвпадение печели
  allow: Record<string, string[]>; // кой слой от кои може да зависи; празно — по стила
  ignore_edges?: string[]; // видове ребра, които не се проверяват
  contexts?: { from: 'namespace_segment' | 'path_segment'; index: number; allow_cross?: string[] };
}

// Позволените посоки по стил (docs/RULES.md): всеки слой зависи само от по-вътрешните.
// Изключенията от строгия ред са обичайните: presentation вижда domain, infrastructure — domain.
export const STYLE_ALLOW: Record<string, Record<string, string[]>> = {
  layered: {
    presentation: ['application', 'domain'],
    application: ['domain', 'infrastructure'],
    domain: [],
    infrastructure: ['domain'],
  },
  clean: {
    frameworks: ['interface-adapters', 'use-cases', 'entities'],
    'interface-adapters': ['use-cases', 'entities'],
    'use-cases': ['entities'],
    entities: [],
  },
  onion: {
    infrastructure: ['application-services', 'domain-services', 'domain-model'],
    'application-services': ['domain-services', 'domain-model'],
    'domain-services': ['domain-model'],
    'domain-model': [],
  },
  hexagonal: {
    adapters: ['application', 'ports', 'domain'],
    application: ['ports', 'domain'],
    ports: ['domain'],
    domain: [],
  },
  mvc: { controller: ['model', 'view'], model: [], view: ['model'] },
  ddd: {
    interfaces: ['application', 'domain'],
    application: ['domain'],
    domain: [],
    infrastructure: ['application', 'domain'],
  },
  none: {},
};

// Позволените посоки за проекта: изричните, иначе тези на стила; без architecture.yaml — layered
// върху слоевете от каталога на ролите.
export function allowOf(arch: Architecture | undefined): Record<string, string[]> {
  if (arch && Object.keys(arch.allow).length) return arch.allow;
  return STYLE_ALLOW[arch?.style ?? 'layered'] ?? {};
}

// Слоевете на стиловете отвън навътре (docs/RULES.md). Без изрични `layers` стилът дава само реда.
export const STYLES: Record<string, string[]> = {
  layered: ['presentation', 'application', 'domain', 'infrastructure'],
  clean: ['frameworks', 'interface-adapters', 'use-cases', 'entities'],
  onion: ['infrastructure', 'application-services', 'domain-services', 'domain-model'],
  hexagonal: ['adapters', 'application', 'ports', 'domain'],
  mvc: ['controller', 'model', 'view'],
  ddd: ['interfaces', 'application', 'domain', 'infrastructure'],
  none: [],
};

export function loadArchitecture(root: string): Architecture | undefined {
  const file = join(root, '.archgraph/architecture.yaml');
  if (!existsSync(file)) return undefined;
  const y = (parse(readFileSync(file, 'utf8')) ?? {}) as Partial<Architecture>;
  const style = y.style ?? 'none';
  if (!(style in STYLES)) throw new Error(`.archgraph/architecture.yaml: непознат стил „${style}“`);
  const arch: Architecture = { style, layers: y.layers ?? [], allow: y.allow ?? {} };
  if (y.ignore_edges) arch.ignore_edges = y.ignore_edges;
  if (y.contexts) arch.contexts = y.contexts;
  return arch;
}

// Редът на слоевете за интерфейса: изричните, иначе тези на стила.
export function layerOrder(arch: Architecture | undefined, fallback: string[]): string[] {
  if (!arch) return fallback;
  return arch.layers.length ? arch.layers.map((l) => l.name) : (STYLES[arch.style] ?? fallback);
}

// Слой и контекст на всеки нод. Слоят от архитектурата заменя този от каталога; без съвпадение
// нодът остава със слоя от каталога.
export function assignLayers(nodes: Node[], arch: Architecture | undefined, facts: RoleFacts): Node[] {
  if (!arch) return nodes;
  return nodes.map((n) => {
    if (n.kind === 'route') return n;
    const layer = arch.layers.find((l) => matches(n, l.match, facts))?.name;
    const context = arch.contexts ? contextOf(n, arch.contexts) : undefined;
    if (!layer && !context) return n;
    return { ...n, ...(layer ? { layer } : {}), ...(context ? { context } : {}) };
  });
}

// `App\Order\Service\X` с index 1 → `Order`; `src/modules/patients/x.py` с path_segment 2 → `patients`.
function contextOf(n: Node, c: NonNullable<Architecture['contexts']>): string | undefined {
  const parts = c.from === 'path_segment' ? n.location.file.split('/') : n.id.replace(/^[a-z]+:/, '').split(/[\\.#/]/);
  return parts[c.index];
}

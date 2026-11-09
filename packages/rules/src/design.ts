import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { STYLES } from './architecture.ts';

// Чертежът на проекта (етап 11, `.archgraph/design.yaml`): стек, архитектурен стил и ендпойнтите.
// Стиловете казват участниците на един ендпойнт по слоеве, стековете — имената, файловете и id-тата им
// (packages/rules/design). Развиването в нодове е в engine (design.ts).

export interface Design {
  stack: string;
  style: string;
  endpoints: DesignEndpoint[];
}

export interface DesignEndpoint {
  method: string; // GET, POST…
  path: string; // `/invoices/{id}`
  entity?: string; // иначе от пътя
  action?: string; // иначе от метода и пътя
  input?: Record<string, string>; // полетата на заявката: име → тип (string, int, float, bool, date, datetime, клас)
  output?: Record<string, string>; // полетата на отговора; стават полета на entity-то
}

export const FIELD_TYPES = ['string', 'int', 'float', 'bool', 'date', 'datetime'];

export interface StylePart {
  layer: string;
  role: string;
  kind?: 'class' | 'interface' | 'template';
  name: string;
  file: string; // видът на файла: папката (PHP, Python) или наставката (Nest) от стека
  per: 'endpoint' | 'entity';
  when?: Condition;
  method?: 'action' | 'execute' | 'handle' | 'storage' | 'domain';
  implements?: string;
}

export type Condition = 'read' | 'write' | 'body' | 'create';

export interface Style {
  style: string;
  label: string;
  about: string;
  layers: string[]; // отвън навътре (STYLES)
  entry: string; // слоят на входа
  parts: Record<string, StylePart>;
  flow: { from: string; to: string; kind?: 'calls' | 'creates' | 'renders'; when?: Condition }[];
}

export interface Stack {
  stack: string;
  label: string;
  language: string;
  bootstrap: string;
  wiring?: string;
  case: 'camel' | 'snake';
  module: string;
  class: { id: string; file: string };
  folders?: Record<string, string>;
  entry: {
    per: 'endpoint' | 'entity';
    kind: 'class' | 'function';
    name: string;
    method?: string;
    id?: string;
    file?: string;
    implements?: string;
    inputs?: { name: string; type: string }[];
    output?: string;
  };
  route: { file?: string; param: string; line?: string };
  template: string;
  types: { id: string; void: string } & Record<string, string>;
  imports?: Record<string, string>;
}

const DIR = join(import.meta.dirname, '../design');

function loadAll<T>(dir: string): T[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => parse(readFileSync(join(dir, f), 'utf8')) as T);
}

export const DESIGN_STYLES: Style[] = loadAll<Omit<Style, 'layers'>>(join(DIR, 'styles')).map((s) => {
  const layers = STYLES[s.style];
  if (!layers) throw new Error(`design/styles: стилът „${s.style}“ го няма в STYLES`);
  for (const [key, p] of Object.entries(s.parts))
    if (!layers.includes(p.layer)) throw new Error(`design/styles/${s.style}: ${key} е в непознат слой „${p.layer}“`);
  return { ...s, layers };
});

export const DESIGN_STACKS: Stack[] = loadAll<Stack>(join(DIR, 'stacks'));

const FILE = '.archgraph/design.yaml';

export function loadDesign(root: string): Design | undefined {
  const file = join(root, FILE);
  if (!existsSync(file)) return undefined;
  const y = (parse(readFileSync(file, 'utf8')) ?? {}) as Partial<Design> & { endpoints?: (string | DesignEndpoint)[] };
  if (!DESIGN_STACKS.some((s) => s.stack === y.stack)) throw new Error(`${FILE}: непознат стек „${y.stack}“`);
  if (!DESIGN_STYLES.some((s) => s.style === y.style)) throw new Error(`${FILE}: непознат стил „${y.style}“`);
  return { stack: y.stack as string, style: y.style as string, endpoints: (y.endpoints ?? []).map(endpointOf) };
}

// Ендпойнтът се пише и кратко: `POST /invoices`.
function endpointOf(e: string | DesignEndpoint): DesignEndpoint {
  if (typeof e !== 'string') return { ...e, method: e.method.toUpperCase() };
  const [method = '', path = ''] = e.trim().split(/\s+/);
  return { method: method.toUpperCase(), path };
}

export function saveDesign(root: string, design: Design) {
  mkdirSync(join(root, '.archgraph'), { recursive: true });
  // кратко `POST /invoices`, а с полета или изрични ресурс и действие — като обект
  const endpoints = design.endpoints.map((e) => {
    const full = Object.fromEntries(
      Object.entries(e).filter(([, v]) => v !== undefined && !(typeof v === 'object' && !Object.keys(v).length)),
    );
    return Object.keys(full).length > 2
      ? { ...full, method: e.method.toUpperCase() }
      : `${e.method.toUpperCase()} ${e.path}`;
  });
  writeFileSync(join(root, FILE), stringify({ stack: design.stack, style: design.style, endpoints }));
}

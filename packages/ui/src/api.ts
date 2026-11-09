import type { PatternResult } from '@archgraph/engine';

// REST API-то на `archgraph serve` (packages/cli/src/serve.ts). В браузъра адресът е същият като на
// страницата; във VS Code панелът е на друг произход и разширението подава адреса в `ARCHGRAPH_API`.

declare global {
  interface Window {
    ARCHGRAPH_API?: string;
    acquireVsCodeApi?: () => { postMessage(message: unknown): void };
  }
}

const BASE = window.ARCHGRAPH_API ?? '';

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body;
}

export async function createPlan(task: string, targets: string[]): Promise<string> {
  const res = await fetch(`${BASE}/api/plans`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task, targets }),
  });
  return res.text();
}

export type Shape = PatternResult & { plan: string };

// Шаблон „като този“: ghost нодове, регистрации и план (POST /api/patterns).
export async function createPattern(example: string, to: string): Promise<Shape> {
  const res = await fetch(`${BASE}/api/patterns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ example, to }),
  });
  const body = (await res.json()) as Shape & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body;
}

export interface DesignEndpoint {
  method: string;
  path: string;
  entity?: string;
  action?: string;
  input?: Fields;
  output?: FieldSpec;
}
// `[тип]` е масив, `{поле: тип}` — вложен обект (става клас)
export type FieldSpec = string | FieldSpec[] | Fields;
export interface Fields {
  [name: string]: FieldSpec;
}
export interface Design {
  stack: string;
  style: string;
  endpoints: DesignEndpoint[];
}
export interface DesignInfo {
  design: Design | null;
  progress: { done: number; total: number } | null;
  warnings: string[];
  objects: string[];
  stacks: { stack: string; label: string; language: string }[];
  styles: { style: string; label: string; about: string; layers: string[]; allow: Record<string, string[]> }[];
}

// Чертежът (етап 11): записва се целият; отговорът идва след като графът е свързан наново.
export async function saveDesign(design: Design): Promise<void> {
  const res = await fetch(`${BASE}/api/design`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(design),
  });
  if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? `${res.status}`);
}

export async function designPlan(): Promise<string> {
  const res = await fetch(`${BASE}/api/design/plan`);
  return res.text();
}

// Известие при промяна на файл: процесът се презарежда.
export function onChange(listener: () => void): () => void {
  const events = new EventSource(`${BASE}/api/events`);
  events.addEventListener('changed', listener);
  return () => events.close();
}

// Във VS Code: съобщения към разширението (отвори файл на ред). В браузъра няма редактор.
const vscode = window.acquireVsCodeApi?.();
export const inEditor = vscode !== undefined;
export function openInEditor(file: string, line: number) {
  vscode?.postMessage({ type: 'open', file, line });
}

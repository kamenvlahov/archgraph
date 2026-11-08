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

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import * as vscode from 'vscode';

// Тънко разширение: пуска `archgraph serve` за папката на проекта като отделен процес и показва
// същия интерфейс (packages/ui) в панел. Панелът и редакторът си говорят през съобщения:
// двоен клик върху нод отваря файла, курсорът в редактора маркира нода.

// UI-ът е копиран до разширението (dist/ui), за да работи и инсталирано без репото, с docker.
const UI = join(__dirname, 'ui');
const CLI = join(__dirname, '../../../packages/cli/src/main.ts'); // само за archgraph.runner: node

let panel: vscode.WebviewPanel | undefined;
let server: ChildProcess | undefined;

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('archgraph.show', () => show(context)),
    vscode.window.onDidChangeTextEditorSelection(
      debounce((e: vscode.TextEditorSelectionChangeEvent) => reveal(e.textEditor), 250),
    ),
    { dispose: stop },
  );
}

export function deactivate() {
  stop();
}

async function show(context: vscode.ExtensionContext) {
  if (panel) return panel.reveal();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return void vscode.window.showWarningMessage('archgraph: отвори папката на проекта.');
  const progress = { location: vscode.ProgressLocation.Notification, title: 'archgraph: сканирам проекта…' };
  const api = await Promise.resolve(vscode.window.withProgress(progress, () => start(root))).catch(
    (e: Error) => void vscode.window.showErrorMessage(`archgraph: ${e.message}`),
  );
  if (!api) return;

  panel = vscode.window.createWebviewPanel('archgraph', 'archgraph', vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.file(UI)],
  });
  panel.webview.html = html(panel.webview, api);
  panel.webview.onDidReceiveMessage(
    async (m: { type?: string; file?: string; line?: number }) => {
      if (m.type !== 'open' || !m.file) return;
      const line = Math.max(0, (m.line ?? 1) - 1);
      const path = vscode.Uri.file(join(root, m.file));
      // Ghost нод от чертежа: файлът още го няма (или е празен). Скелетът от чертежа (класът,
      // зависимостите, методите) се записва само ако го поискаш (D-014); телата пишеш ти или агентът.
      if (!existsSync(path.fsPath) || !readFileSync(path.fsPath, 'utf8').trim()) {
        const res = await fetch(`${api}/api/design/skeleton?file=${encodeURIComponent(m.file)}`).catch(() => undefined);
        const code = res?.ok ? await res.text() : '';
        const create = code ? 'Създай със скелета' : 'Създай празен файл';
        const answer = await vscode.window.showInformationMessage(`archgraph: ${m.file} още го няма.`, create);
        if (answer !== create) return;
        await vscode.workspace.fs.writeFile(path, new TextEncoder().encode(code));
      }
      const doc = await vscode.workspace.openTextDocument(path);
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One,
        selection: new vscode.Range(line, 0, line, 0),
      });
    },
    undefined,
    context.subscriptions,
  );
  panel.onDidDispose(() => {
    panel = undefined;
    stop();
  });
}

// `archgraph serve`: портът е в реда `archgraph: http://127.0.0.1:<порт>` на stderr.
async function start(root: string): Promise<string> {
  const config = vscode.workspace.getConfiguration('archgraph');
  const scip = config.get('scip') ? ['--scip'] : [];
  // С docker archgraph не зависи от Node-а на машината. Проектът се монтира на същия път, за да съвпадат
  // пътищата с тези на редактора, а файловете, които archgraph записва (design.yaml), са на потребителя.
  const [command, args] =
    config.get('runner') === 'docker'
      ? await free().then((port): [string, string[]] => [
          'docker',
          [
            'run',
            '--rm',
            '--init',
            ...(process.getuid && process.getgid ? ['--user', `${process.getuid()}:${process.getgid()}`] : []),
            '-v',
            `${root}:${root}`,
            '-p',
            `127.0.0.1:${port}:${port}`,
            config.get('image', 'archgraph'),
            'serve',
            root,
            '--port',
            String(port),
            '--host',
            '0.0.0.0',
            ...scip,
          ],
        ])
      : [config.get('node', 'node'), [CLI, 'serve', root, '--port', '0', ...scip]];
  server = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolve, reject) => {
    let log = '';
    server?.stderr?.on('data', (chunk: Buffer) => {
      log += chunk.toString();
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(log);
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
    server?.on('error', (e) => reject(new Error(`не мога да пусна ${command}: ${e.message}`)));
    server?.on('exit', (code) => reject(new Error(`engine-ът спря (${code}): ${log.trim().split('\n').at(-1) ?? ''}`)));
  });
}

// Свободен порт на хоста: в контейнера serve трябва да слуша на същия, който е пренасочен.
function free(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('няма порт')),
      );
    });
  });
}

function stop() {
  server?.kill();
  server = undefined;
}

// index.html на UI-а с адресите на файловете за webview, адреса на API-то и CSP.
function html(webview: vscode.Webview, api: string): string {
  const asset = (path: string) => webview.asWebviewUri(vscode.Uri.file(join(UI, path))).toString();
  const nonce = Math.random().toString(36).slice(2);
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    `connect-src ${api}`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  return readFileSync(join(UI, 'index.html'), 'utf8')
    .replaceAll(' crossorigin', '')
    .replace(/(src|href)="\/([^"]+)"/g, (_, attr: string, path: string) => `${attr}="${asset(path)}"`)
    .replace('<script type="module"', `<script type="module" nonce="${nonce}"`)
    .replace(
      '<head>',
      `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">\n<script nonce="${nonce}">window.ARCHGRAPH_API = ${JSON.stringify(api)};</script>`,
    );
}

// Курсорът в редактора → панелът маркира нода на това място, ако е в показания процес.
function reveal(editor: vscode.TextEditor) {
  if (!panel || editor.document.uri.scheme !== 'file') return;
  void panel.webview.postMessage({
    type: 'reveal',
    file: editor.document.uri.fsPath,
    line: editor.selection.active.line + 1,
  });
}

function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: NodeJS.Timeout | undefined;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

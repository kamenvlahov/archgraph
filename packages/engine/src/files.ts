import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, matchesGlob, relative, sep } from 'node:path';

// Зависимости, бъндъли и генериран код не са архитектура на проекта.
export const DEFAULT_EXCLUDES = [
  '.git',
  '.archgraph',
  'node_modules',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  '*.min.js',
  '*.d.ts',
];

// Бъндъл или генериран файл (gradio в omnivoice има JS от 4,5 MB).
export const MAX_FILE_SIZE = 1_000_000;

// Шаблон без `/` важи за всеки сегмент от пътя (`vendor`, `*.min.js`), с `/` – за целия относителен път.
export function isExcluded(path: string, patterns: string[]): boolean {
  const segments = path.split('/');
  return patterns.some((p) => (p.includes('/') ? matchesGlob(path, p) : segments.some((s) => matchesGlob(s, p))));
}

// В git хранилище файловете идват от git, така че .gitignore се спазва точно. Извън git – обхождане на папките.
export function listFiles(root: string, exclude: string[]): string[] {
  const all = gitFiles(root) ?? walk(root, root, exclude);
  return all.filter((p) => !isExcluded(p, exclude)).sort();
}

function gitFiles(root: string): string[] | undefined {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024 * 1024,
    });
    return out.split('\0').filter(Boolean);
  } catch {
    return undefined;
  }
}

function walk(root: string, dir: string, exclude: string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = relative(root, join(dir, entry.name)).split(sep).join('/');
    if (isExcluded(path, exclude)) return [];
    if (entry.isDirectory()) return walk(root, join(dir, entry.name), exclude);
    return entry.isFile() ? [path] : [];
  });
}

export function isTooBig(file: string, max: number): boolean {
  return statSync(file).size > max;
}

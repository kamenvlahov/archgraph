import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

// Каталогът на ролите (D-007, packages/rules/catalog.yaml): слой по подразбиране и цвят за всяка роля.
export interface RoleInfo {
  layer: string;
  color: string;
}

export const CATALOG: Record<string, RoleInfo> = (
  parse(readFileSync(join(import.meta.dirname, '../catalog.yaml'), 'utf8')) as { roles: Record<string, RoleInfo> }
).roles;

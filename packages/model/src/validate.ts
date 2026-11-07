import {
  CONFIDENCES,
  MODEL_VERSION,
  TYPE_REF_KINDS,
  VISIBILITIES,
  type GraphModel,
  type Member,
  type Node,
} from './types.ts';
import { CORE_REGISTRY, type Registry } from './registry.ts';

export interface ValidationError {
  path: string;
  message: string;
}

export type ValidationResult = { ok: true; model: GraphModel } | { ok: false; errors: ValidationError[] };

type Obj = Record<string, unknown>;

// Проверява формата (същото като schema.json) и връзките вътре в графа:
// уникални id-та, ребрата сочат към съществуващи нодове, методи и портове.
// Видовете и езиците се приемат, ако са в регистъра (ядро + разширения).
export function validate(input: unknown, registry: Registry = CORE_REGISTRY): ValidationResult {
  const errors: ValidationError[] = [];
  const fail = (path: string, message: string) => errors.push({ path, message });

  const isObj = (v: unknown, path: string): v is Obj => {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return true;
    fail(path, 'трябва да е обект');
    return false;
  };
  const isArr = (v: unknown, path: string): v is unknown[] => {
    if (Array.isArray(v)) return true;
    fail(path, 'трябва да е масив');
    return false;
  };
  const str = (o: Obj, key: string, path: string, required = true) => {
    const v = o[key];
    if (v === undefined && !required) return;
    if (typeof v !== 'string' || v === '') fail(`${path}.${key}`, 'трябва да е непразен низ');
  };
  const bool = (o: Obj, key: string, path: string) => {
    if (o[key] !== undefined && typeof o[key] !== 'boolean') fail(`${path}.${key}`, 'трябва да е boolean');
  };
  const only = (o: Obj, allowed: string[], path: string) => {
    for (const key of Object.keys(o)) if (!allowed.includes(key)) fail(`${path}.${key}`, 'непознато поле');
  };
  const oneOf = (o: Obj, key: string, allowed: readonly string[], path: string) => {
    if (!allowed.includes(o[key] as string)) fail(`${path}.${key}`, `трябва да е едно от: ${allowed.join(', ')}`);
  };

  const location = (v: unknown, path: string) => {
    if (!isObj(v, path)) return;
    only(v, ['file', 'line', 'endLine'], path);
    str(v, 'file', path);
    const { line, endLine } = v;
    if (!Number.isInteger(line) || (line as number) < 1) fail(`${path}.line`, 'трябва да е цяло число ≥ 1');
    if (!Number.isInteger(endLine) || (endLine as number) < (line as number))
      fail(`${path}.endLine`, 'трябва да е цяло число ≥ line');
  };

  const typeRef = (v: unknown, path: string): void => {
    if (!isObj(v, path)) return;
    oneOf(v, 'kind', TYPE_REF_KINDS, path);
    switch (v.kind) {
      case 'named':
        only(v, ['kind', 'id', 'args'], path);
        str(v, 'id', path);
        if (v.args !== undefined && isArr(v.args, `${path}.args`))
          v.args.forEach((a, i) => typeRef(a, `${path}.args[${i}]`));
        break;
      case 'primitive':
        only(v, ['kind', 'name'], path);
        str(v, 'name', path);
        break;
      case 'array':
        only(v, ['kind', 'of'], path);
        typeRef(v.of, `${path}.of`);
        break;
      case 'map':
        only(v, ['kind', 'key', 'value'], path);
        typeRef(v.key, `${path}.key`);
        typeRef(v.value, `${path}.value`);
        break;
      case 'union':
        only(v, ['kind', 'of'], path);
        if (isArr(v.of, `${path}.of`)) v.of.forEach((t, i) => typeRef(t, `${path}.of[${i}]`));
        break;
      case 'shape':
        only(v, ['kind', 'fields'], path);
        fields(v.fields, `${path}.fields`);
        break;
      case 'unknown':
        only(v, ['kind', 'hint'], path);
        str(v, 'hint', path, false);
        break;
    }
  };

  const fields = (v: unknown, path: string) => {
    if (!isArr(v, path)) return;
    v.forEach((f, i) => {
      const p = `${path}[${i}]`;
      if (!isObj(f, p)) return;
      only(f, ['name', 'type', 'optional', 'readonly'], p);
      str(f, 'name', p);
      typeRef(f.type, `${p}.type`);
      bool(f, 'optional', p);
      bool(f, 'readonly', p);
    });
  };

  const port = (v: unknown, path: string) => {
    if (!isObj(v, path)) return;
    only(v, ['name', 'type', 'optional', 'default', 'variadic'], path);
    str(v, 'name', path);
    typeRef(v.type, `${path}.type`);
    bool(v, 'optional', path);
    bool(v, 'variadic', path);
    if (v.default !== undefined && typeof v.default !== 'string') fail(`${path}.default`, 'трябва да е низ');
  };

  const member = (v: unknown, path: string) => {
    if (!isObj(v, path)) return;
    only(v, ['name', 'visibility', 'static', 'async', 'inputs', 'output', 'throws', 'location'], path);
    str(v, 'name', path);
    oneOf(v, 'visibility', VISIBILITIES, path);
    bool(v, 'static', path);
    bool(v, 'async', path);
    if (isArr(v.inputs, `${path}.inputs`)) v.inputs.forEach((p, i) => port(p, `${path}.inputs[${i}]`));
    if (v.output !== undefined) port(v.output, `${path}.output`);
    if (v.throws !== undefined && isArr(v.throws, `${path}.throws`))
      v.throws.forEach((t, i) => typeRef(t, `${path}.throws[${i}]`));
    location(v.location, `${path}.location`);
  };

  const node = (v: unknown, path: string) => {
    if (!isObj(v, path)) return;
    only(
      v,
      ['id', 'kind', 'name', 'language', 'role', 'framework', 'layer', 'context', 'location', 'members', 'tags'],
      path,
    );
    str(v, 'id', path);
    oneOf(v, 'kind', [...registry.nodeKinds], path);
    str(v, 'name', path);
    oneOf(v, 'language', [...registry.languages], path);
    str(v, 'role', path, false);
    str(v, 'framework', path, false);
    str(v, 'layer', path, false);
    str(v, 'context', path, false);
    location(v.location, `${path}.location`);
    if (isArr(v.members, `${path}.members`)) v.members.forEach((m, i) => member(m, `${path}.members[${i}]`));
    if (v.tags !== undefined && isArr(v.tags, `${path}.tags`))
      v.tags.forEach((t, i) => typeof t !== 'string' && fail(`${path}.tags[${i}]`, 'трябва да е низ'));
  };

  const edgeEnd = (v: unknown, path: string) => {
    if (!isObj(v, path)) return;
    only(v, ['node', 'member', 'port'], path);
    str(v, 'node', path);
    str(v, 'member', path, false);
    str(v, 'port', path, false);
  };

  const edge = (v: unknown, path: string) => {
    if (!isObj(v, path)) return;
    only(v, ['id', 'kind', 'from', 'to', 'confidence', 'location'], path);
    str(v, 'id', path);
    oneOf(v, 'kind', [...registry.edgeKinds], path);
    edgeEnd(v.from, `${path}.from`);
    edgeEnd(v.to, `${path}.to`);
    oneOf(v, 'confidence', CONFIDENCES, path);
    if (v.location !== undefined) location(v.location, `${path}.location`);
  };

  if (!isObj(input, '$')) return { ok: false, errors };
  only(input, ['version', 'root', 'nodes', 'edges', 'types', 'unresolved'], '$');
  if (input.version !== MODEL_VERSION) fail('$.version', `трябва да е ${MODEL_VERSION}`);
  str(input, 'root', '$');
  if (isArr(input.nodes, '$.nodes')) input.nodes.forEach((n, i) => node(n, `$.nodes[${i}]`));
  if (isArr(input.edges, '$.edges')) input.edges.forEach((e, i) => edge(e, `$.edges[${i}]`));
  if (input.unresolved !== undefined && isArr(input.unresolved, '$.unresolved'))
    input.unresolved.forEach((u, i) => {
      const p = `$.unresolved[${i}]`;
      if (!isObj(u, p)) return;
      only(u, ['from', 'name', 'line'], p);
      if (isObj(u.from, `${p}.from`)) {
        only(u.from, ['node', 'member'], `${p}.from`);
        str(u.from, 'node', `${p}.from`);
        str(u.from, 'member', `${p}.from`);
      }
      str(u, 'name', p);
      if (!Number.isInteger(u.line) || (u.line as number) < 1) fail(`${p}.line`, 'трябва да е цяло число ≥ 1');
    });
  if (isObj(input.types, '$.types')) {
    for (const [key, shape] of Object.entries(input.types)) {
      const p = `$.types[${JSON.stringify(key)}]`;
      if (!isObj(shape, p)) continue;
      only(shape, ['id', 'name', 'nodeId', 'fields'], p);
      if (shape.id !== key) fail(`${p}.id`, 'трябва да съвпада с ключа');
      str(shape, 'name', p);
      str(shape, 'nodeId', p, false);
      fields(shape.fields, `${p}.fields`);
    }
  }

  // Връзките се проверяват само върху структурно валиден граф.
  if (errors.length > 0) return { ok: false, errors };
  const model = input as unknown as GraphModel;

  const nodes = new Map<string, Node>();
  model.nodes.forEach((n, i) => {
    if (nodes.has(n.id)) fail(`$.nodes[${i}].id`, `повторено id "${n.id}"`);
    nodes.set(n.id, n);
  });

  const edgeIds = new Set<string>();
  model.edges.forEach((e, i) => {
    const p = `$.edges[${i}]`;
    if (edgeIds.has(e.id)) fail(`${p}.id`, `повторено id "${e.id}"`);
    edgeIds.add(e.id);
    for (const side of ['from', 'to'] as const) {
      const end = e[side];
      const n = nodes.get(end.node);
      if (!n) {
        fail(`${p}.${side}.node`, `няма нод "${end.node}"`);
        continue;
      }
      if (end.port !== undefined && end.member === undefined) {
        fail(`${p}.${side}.port`, 'порт без member');
        continue;
      }
      if (end.member === undefined) continue;
      const m = n.members.find((x) => x.name === end.member);
      if (!m) fail(`${p}.${side}.member`, `"${n.id}" няма member "${end.member}"`);
      else if (end.port !== undefined && !hasPort(m, end.port))
        fail(`${p}.${side}.port`, `"${n.id}::${m.name}" няма порт "${end.port}"`);
    }
  });

  model.unresolved?.forEach((u, i) => {
    const n = nodes.get(u.from.node);
    if (!n) fail(`$.unresolved[${i}].from.node`, `няма нод "${u.from.node}"`);
    else if (!n.members.some((m) => m.name === u.from.member))
      fail(`$.unresolved[${i}].from.member`, `"${n.id}" няма member "${u.from.member}"`);
  });

  for (const [key, shape] of Object.entries(model.types)) {
    if (shape.nodeId !== undefined && !nodes.has(shape.nodeId))
      fail(`$.types[${JSON.stringify(key)}].nodeId`, `няма нод "${shape.nodeId}"`);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, model };
}

function hasPort(m: Member, name: string): boolean {
  return m.inputs.some((p) => p.name === name) || m.output?.name === name;
}

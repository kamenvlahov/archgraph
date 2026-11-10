import { useState } from 'react';
import {
  designPlan,
  saveDesign,
  type Design,
  type DesignInfo,
  type FieldSpec,
  type Fields,
  type Resource,
} from './api.ts';

// Проектиране от нулата (етап 11): изборът на стек и стил в празна папка, слоевете на стила и
// добавянето на ендпойнти. Чертежът е .archgraph/design.yaml; ghost нодовете ги прави engine-ът.

type StyleInfo = DesignInfo['styles'][number];

export function DesignStart({ info }: { info: DesignInfo }) {
  const [stack, setStack] = useState(info.stacks[0]?.stack ?? '');
  const [style, setStyle] = useState('layered');
  const [error, setError] = useState<string>();
  const chosen = info.styles.find((s) => s.style === style);
  return (
    <div id="start">
      <h1>Нов проект</h1>
      <p className="lead">
        Папката е празна. Избери стек и архитектура; после описваш ендпойнтите един по един и archgraph показва какво
        трябва да се напише и в кой слой.
      </p>
      <h3>Стек</h3>
      <div className="cards">
        {info.stacks.map((s) => (
          <button key={s.stack} className={s.stack === stack ? 'card on' : 'card'} onClick={() => setStack(s.stack)}>
            <b>{s.label}</b>
          </button>
        ))}
      </div>
      <h3>Архитектура</h3>
      <div className="cards">
        {info.styles.map((s) => (
          <button key={s.style} className={s.style === style ? 'card on' : 'card'} onClick={() => setStyle(s.style)}>
            <b>{s.label}</b>
            <span>{s.about}</span>
          </button>
        ))}
      </div>
      {chosen && <Layers style={chosen} />}
      {error && <div className="bad">{error}</div>}
      <button
        className="btn pri"
        onClick={() => saveDesign({ stack, style, endpoints: [] }).catch((e: Error) => setError(e.message))}
      >
        Започни
      </button>
    </div>
  );
}

// Слоевете на стила отвън навътре и от кои зависи всеки.
export function Layers({ style }: { style: StyleInfo }) {
  return (
    <div className="layers">
      {style.layers.map((l) => (
        <div key={l} className="band">
          <b>{l}</b>
          <span>{style.allow[l]?.length ? `→ ${style.allow[l].join(', ')}` : 'не зависи от нищо'}</span>
        </div>
      ))}
    </div>
  );
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const TYPES = ['string', 'int', 'float', 'bool', 'date', 'datetime', 'object', 'object[]', 'string[]', 'int[]'];

type Level = 1 | 2 | 3;

// Секцията в лявото меню: стилът, напредъкът, изгледът „Архитектура“, нов ендпойнт и планът.
export function DesignNav({
  info,
  onAdded,
  arch,
  onArch,
  levels,
  onLevel,
}: {
  info: DesignInfo;
  onAdded: (method: string, path: string) => void;
  arch: boolean;
  onArch: () => void;
  levels: Record<string, Level> | undefined; // нивата от пробата
  onLevel: (name: string, level: Level) => void;
}) {
  const [method, setMethod] = useState('GET');
  const [path, setPath] = useState('');
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const design = info.design as Design;
  const style = info.styles.find((s) => s.style === design.style);
  const stack = info.stacks.find((s) => s.stack === design.stack);
  const add = () => {
    const clean = path.trim();
    if (!clean) return setError('напиши пътя: /invoices');
    const endpoint = { method, path: clean.startsWith('/') ? clean : `/${clean}` };
    setError(undefined);
    saveDesign({ ...design, endpoints: [...design.endpoints, endpoint] })
      .then(() => {
        setPath('');
        onAdded(endpoint.method, endpoint.path);
      })
      .catch((e: Error) => setError(e.message));
  };
  const copy = async () => {
    await navigator.clipboard?.writeText(await designPlan()).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="design">
      <h3>Чертеж</h3>
      <div className="sub">
        {style?.label} · {stack?.label}
        {info.progress && info.progress.total > 0 && (
          <span>
            {' '}
            · готово {info.progress.done} от {info.progress.total}
          </span>
        )}
      </div>
      <ul>
        <li className={arch ? 'on' : ''} onClick={onArch}>
          Архитектура
          <small>модули × слоеве, проба с друга</small>
        </li>
      </ul>
      <form
        className="add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          {METHODS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <input placeholder="/invoices/{id}" value={path} onChange={(e) => setPath(e.target.value)} />
        <button className="btn" type="submit" title="добави ендпойнта">
          +
        </button>
      </form>
      {error && <div className="hint bad">{error}</div>}
      {info.warnings.map((w) => (
        <div key={w} className="hint bad">
          {w}
        </div>
      ))}
      {design.endpoints.length > 0 && (
        <button className="btn" onClick={copy}>
          {copied ? 'Копирано' : 'Копирай плана за AI'}
        </button>
      )}
      <Resources info={info} levels={levels} onLevel={onLevel} />
      <datalist id="field-types">
        {[...TYPES, ...info.objects, ...info.objects.map((o) => `${o}[]`)].map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </div>
  );
}

// Ресурсите (entity-тата): кой е влезлият, чий е всеки ресурс и полетата му. По веригата от собственици
// до влезлия engine-ът знае чии са данните: съобщенията носят id-то му, списъците са само негови.
// Нивото не се записва веднага: смяната му е проба в изгледа „Архитектура“, като смяната на стила.
function Resources({
  info,
  levels,
  onLevel,
}: {
  info: DesignInfo;
  levels: Record<string, Level> | undefined;
  onLevel: (name: string, level: Level) => void;
}) {
  const design = info.design as Design;
  const [open, setOpen] = useState<string>();
  const [error, setError] = useState<string>();
  const save = (next: Partial<Design>) =>
    saveDesign({ ...design, ...next })
      .then(() => setError(undefined))
      .catch((e: Error) => setError(e.message));
  const setResource = (name: string, r: Resource) => save({ resources: { ...design.resources, [name]: r } });
  if (!info.entities.length) return null;
  return (
    <div className="resources">
      <h4 title="ресурсът на потребителя; тогава ендпойнтите искат вход, освен публичните">Влезлият</h4>
      <select value={design.auth ?? ''} onChange={(e) => void save({ auth: e.target.value || undefined })}>
        <option value="">без вход</option>
        {info.entities.map((x) => (
          <option key={x}>{x}</option>
        ))}
      </select>
      <h4>Ресурси</h4>
      {info.entities.map((name) => {
        const r = design.resources?.[name] ?? {};
        return (
          <div key={name} className="resource">
            <div className="row">
              <span className="name" onClick={() => setOpen(open === name ? undefined : name)} title="полетата">
                {open === name ? '▾' : '▸'} {name}
              </span>
              <select
                title="на колко парчета се разбива: 1 просто, 2 service за ресурса, 3 use case за всяко действие"
                className={levels?.[name] ? 'trying' : ''}
                value={levels?.[name] ?? r.level ?? 3}
                onChange={(e) => onLevel(name, Number(e.target.value) as Level)}
              >
                <option value={3}>ниво 3</option>
                <option value={2}>ниво 2</option>
                <option value={1}>ниво 1</option>
              </select>
              <select
                title="чий е"
                value={r.owner ?? ''}
                onChange={(e) => void setResource(name, { ...r, owner: e.target.value || undefined })}
              >
                <option value="">ничий</option>
                {info.entities
                  .filter((x) => x !== name)
                  .map((x) => (
                    <option key={x} value={x}>
                      на {x}
                    </option>
                  ))}
              </select>
            </div>
            {open === name && (
              <ResourceFields key={name} value={r.fields} onSave={(fields) => setResource(name, { ...r, fields })} />
            )}
          </div>
        );
      })}
      {error && <div className="hint bad">{error}</div>}
    </div>
  );
}

function ResourceFields({ value, onSave }: { value?: Fields | undefined; onSave: (f: Fields) => Promise<void> }) {
  const [fields, setFields] = useState(rows(value));
  return (
    <>
      <Fields hint="полетата на entity-то; id и собственикът се добавят сами" value={fields} onChange={setFields} />
      <button className="btn" onClick={() => void onSave(record(fields))}>
        Запази полетата
      </button>
    </>
  );
}

// Изходът в падащото меню: '' — по подразбиране, FIELDS — нов клас с полета, иначе типът (Gallery, Gallery[]).
const FIELDS = '{полета}';
function returnsOf(o?: FieldSpec): string {
  if (o === undefined) return '';
  if (typeof o === 'string') return o;
  if (Array.isArray(o)) return typeof o[0] === 'string' ? `${o[0]}[]` : FIELDS + '[]';
  return FIELDS;
}
const fieldsOf = (o?: FieldSpec): Row[] => {
  const x = Array.isArray(o) ? o[0] : o;
  return x && typeof x === 'object' && !Array.isArray(x) ? rows(x) : [];
};
const returnSpec = (r: string): FieldSpec | undefined => (!r ? undefined : r.endsWith('[]') ? [r.slice(0, -2)] : r);

// Ред в редактора: типът е текст; `object` и `object[]` имат вложени полета, `тип[]` е масив.
type Row = { name: string; type: string; fields?: Row[] };
const nests = (type: string) => type === 'object' || type === 'object[]';
const rows = (f?: Fields): Row[] => Object.entries(f ?? {}).map(([name, t]) => ({ name, ...row(t) }));
function row(t: FieldSpec): Omit<Row, 'name'> {
  if (typeof t === 'string') return { type: t };
  if (Array.isArray(t)) {
    const of = row(t[0] ?? 'string');
    return of.fields ? { type: 'object[]', fields: of.fields } : { type: `${of.type}[]` };
  }
  return { type: 'object', fields: rows(t) };
}
const record = (r: Row[]): Fields =>
  Object.fromEntries(
    r
      .filter((x) => x.name.trim())
      .map((x) => {
        const type = x.type.trim() || 'string';
        const inner = record(x.fields ?? []);
        if (type === 'object') return [x.name.trim(), inner];
        if (type === 'object[]') return [x.name.trim(), [inner]];
        if (type.endsWith('[]')) return [x.name.trim(), [type.slice(0, -2)]];
        return [x.name.trim(), type];
      }),
  );

// Ендпойнтът от чертежа в десния панел: метод, път и полетата на входа и изхода с типовете им.
// Входът става полета на DTO (или параметри на методите), изходът — полета на entity-то.
export function EndpointEditor({
  info,
  label,
  onSaved,
}: {
  info: DesignInfo;
  label: string;
  onSaved: (method: string, path: string) => void;
}) {
  const design = info.design as Design;
  const index = design.endpoints.findIndex((e) => routeKey(`${e.method} ${e.path}`) === routeKey(label));
  const current = design.endpoints[index];
  const [method, setMethod] = useState(current?.method ?? 'GET');
  const [path, setPath] = useState(current?.path ?? '');
  const [input, setInput] = useState(rows(current?.input));
  const [returns, setReturns] = useState(returnsOf(current?.output));
  const [output, setOutput] = useState(fieldsOf(current?.output));
  const [open, setOpen] = useState(current?.public ?? false);
  const [error, setError] = useState<string>();
  if (!current) return null;
  const save = () => {
    const out =
      returns === FIELDS ? record(output) : returns === FIELDS + '[]' ? [record(output)] : returnSpec(returns);
    const { output: _, public: __, ...rest } = current;
    const next = {
      ...rest,
      ...(open ? { public: true } : {}),
      method,
      path: path.startsWith('/') ? path : `/${path}`,
      input: record(input),
      ...(out === undefined ? {} : { output: out }),
    };
    const endpoints = design.endpoints.map((e, i) => (i === index ? next : e));
    saveDesign({ ...design, endpoints })
      .then(() => {
        setError(undefined);
        onSaved(next.method, next.path);
      })
      .catch((e: Error) => setError(e.message));
  };
  return (
    <div className="endpoint">
      <h3>Ендпойнт от чертежа</h3>
      <div className="add">
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          {METHODS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <input value={path} onChange={(e) => setPath(e.target.value)} />
      </div>
      {design.auth && (
        <label className="public">
          <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> публичен (без вход)
        </label>
      )}
      <Fields title="Вход" hint="полетата на заявката" value={input} onChange={setInput} />
      <div className="fields">
        <h4 title="какво връщат методите на ендпойнта">Изход</h4>
        <select value={returns} onChange={(e) => setReturns(e.target.value)}>
          <option value="">по подразбиране (ресурсът)</option>
          <option value={FIELDS}>нов клас с полета</option>
          <option value={FIELDS + '[]'}>масив от нов клас с полета</option>
          {info.objects.flatMap((o) => [
            <option key={o} value={o}>
              {o}
            </option>,
            <option key={`${o}[]`} value={`${o}[]`}>
              {o}[]
            </option>,
          ])}
          {['int', 'bool', 'string', 'void'].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>
      {returns.startsWith(FIELDS) && (
        <Fields
          hint="полетата на класа за отговора; при списък — на един елемент"
          value={output}
          onChange={setOutput}
        />
      )}
      {error && <div className="hint bad">{error}</div>}
      <button className="btn pri" onClick={save}>
        Запази
      </button>
    </div>
  );
}

function Fields({
  title,
  hint,
  value,
  onChange,
}: {
  title?: string;
  hint?: string;
  value: Row[];
  onChange: (r: Row[]) => void;
}) {
  const set = (i: number, row: Row) => onChange(value.map((r, j) => (j === i ? row : r)));
  return (
    <div className={title ? 'fields' : 'fields inner'}>
      {title && <h4 title={hint}>{title}</h4>}
      {value.map((r, i) => (
        <div key={i}>
          <div className="field">
            <input placeholder="име" value={r.name} onChange={(e) => set(i, { ...r, name: e.target.value })} />
            <input
              placeholder="тип"
              list="field-types"
              value={r.type}
              onChange={(e) =>
                set(i, {
                  ...r,
                  type: e.target.value,
                  ...(nests(e.target.value) ? { fields: r.fields ?? [{ name: '', type: 'string' }] } : {}),
                })
              }
            />
            <span className="x" title="махни" onClick={() => onChange(value.filter((_, j) => j !== i))}>
              ✕
            </span>
          </div>
          {nests(r.type) && <Fields value={r.fields ?? []} onChange={(f) => set(i, { ...r, fields: f })} />}
        </div>
      ))}
      <span className="more" onClick={() => onChange([...value, { name: '', type: 'string' }])}>
        + поле
      </span>
    </div>
  );
}

// Махане на ендпойнт от чертежа (✕ в списъка). Сравнението е без имената на параметрите.
export function removeEndpoint(info: DesignInfo, label: string): Promise<void> | undefined {
  const design = info.design;
  if (!design) return undefined;
  const key = routeKey(label);
  const endpoints = design.endpoints.filter((e) => routeKey(`${e.method} ${e.path}`) !== key);
  if (endpoints.length === design.endpoints.length) return undefined;
  return saveDesign({ ...design, endpoints });
}

export function routeKey(label: string): string {
  const [method = '', path = ''] = label.split(' ');
  return `${method} ${path.replace(/\{[^}]*\}|:\w+/g, '{}').replace(/\/$/, '')}`;
}

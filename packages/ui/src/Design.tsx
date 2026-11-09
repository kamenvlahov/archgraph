import { useState } from 'react';
import { designPlan, saveDesign, type Design, type DesignInfo } from './api.ts';

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
const TYPES = ['string', 'int', 'float', 'bool', 'date', 'datetime'];

// Секцията в лявото меню: стилът, напредъкът, нов ендпойнт и планът.
export function DesignNav({ info, onAdded }: { info: DesignInfo; onAdded: (method: string, path: string) => void }) {
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
    </div>
  );
}

type Row = { name: string; type: string };
const rows = (f?: Record<string, string>): Row[] => Object.entries(f ?? {}).map(([name, type]) => ({ name, type }));
const record = (r: Row[]) =>
  Object.fromEntries(r.filter((x) => x.name.trim()).map((x) => [x.name.trim(), x.type.trim() || 'string']));

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
  const [output, setOutput] = useState(rows(current?.output));
  const [error, setError] = useState<string>();
  if (!current) return null;
  const save = () => {
    const next = {
      ...current,
      method,
      path: path.startsWith('/') ? path : `/${path}`,
      input: record(input),
      output: record(output),
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
      <Fields title="Вход" hint="полетата на заявката" value={input} onChange={setInput} />
      <Fields
        title="Изход"
        hint="полетата на отговора (на entity-то); за списък — на един елемент"
        value={output}
        onChange={setOutput}
      />
      {error && <div className="hint bad">{error}</div>}
      <button className="btn pri" onClick={save}>
        Запази
      </button>
      <datalist id="field-types">
        {TYPES.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </div>
  );
}

function Fields({
  title,
  hint,
  value,
  onChange,
}: {
  title: string;
  hint: string;
  value: Row[];
  onChange: (r: Row[]) => void;
}) {
  const set = (i: number, row: Row) => onChange(value.map((r, j) => (j === i ? row : r)));
  return (
    <div className="fields">
      <h4 title={hint}>{title}</h4>
      {value.map((r, i) => (
        <div key={i} className="field">
          <input placeholder="име" value={r.name} onChange={(e) => set(i, { ...r, name: e.target.value })} />
          <input
            placeholder="тип"
            list="field-types"
            value={r.type}
            onChange={(e) => set(i, { ...r, type: e.target.value })}
          />
          <span className="x" title="махни" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            ✕
          </span>
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

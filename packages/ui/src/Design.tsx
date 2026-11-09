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

// Секцията в лявото меню: стилът, напредъкът, нов ендпойнт и планът.
export function DesignNav({ info, onAdded }: { info: DesignInfo; onAdded: (method: string, path: string) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const design = info.design as Design;
  const style = info.styles.find((s) => s.style === design.style);
  const stack = info.stacks.find((s) => s.stack === design.stack);
  const add = () => {
    const [method = '', path = ''] = text.trim().split(/\s+/);
    const endpoint = { method: method.toUpperCase(), path: path.startsWith('/') ? path : `/${path}` };
    if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(endpoint.method) || path === '')
      return setError('напиши метод и път: POST /invoices');
    setError(undefined);
    saveDesign({ ...design, endpoints: [...design.endpoints, endpoint] })
      .then(() => {
        setText('');
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
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input placeholder="нов ендпойнт: POST /invoices" value={text} onChange={(e) => setText(e.target.value)} />
      </form>
      {error && <div className="hint bad">{error}</div>}
      {design.endpoints.length > 0 && (
        <button className="btn" onClick={copy}>
          {copied ? 'Копирано' : 'Копирай плана за AI'}
        </button>
      )}
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

import { useEffect, useState } from 'react';
import {
  designEfforts,
  saveDesign,
  type Design,
  type DesignInfo,
  type Effort,
  type StatusReport,
  type Trial,
} from './api.ts';

// Изгледът „Архитектура“: модулите (ресурсите) × слоевете на стила, с класовете от чертежа. Горе езикът и
// архитектурата; смяната им или на нивото на ресурс е проба: нищо не се записва, а несъвпаденията светват.

type Level = 1 | 2 | 3;
type StatusClass = StatusReport['classes'][number];
type StatusExtra = StatusReport['extra'][number];

// Пробата без това, което съвпада със записания чертеж; празна проба е undefined.
export function cleanTrial(trial: Trial, design: Design): Trial | undefined {
  const levels = Object.fromEntries(
    Object.entries(trial.levels ?? {}).filter(([name, level]) => level !== (design.resources?.[name]?.level ?? 3)),
  );
  const next: Trial = {
    ...(trial.style && trial.style !== design.style ? { style: trial.style } : {}),
    ...(trial.stack && trial.stack !== design.stack ? { stack: trial.stack } : {}),
    ...(Object.keys(levels).length ? { levels } : {}),
  };
  return Object.keys(next).length ? next : undefined;
}

// Чертежът с приложената проба: нивото 3 не се пише.
function applied(design: Design, trial: Trial): Design {
  const resources = { ...design.resources };
  for (const [name, level] of Object.entries(trial.levels ?? {}))
    resources[name] = { ...resources[name], level: level === 3 ? undefined : level };
  return { ...design, style: trial.style ?? design.style, stack: trial.stack ?? design.stack, resources };
}

function trialLabel(info: DesignInfo, trial: Trial): string {
  return [
    trial.stack && info.stacks.find((s) => s.stack === trial.stack)?.label,
    trial.style && info.styles.find((s) => s.style === trial.style)?.label,
    ...Object.entries(trial.levels ?? {}).map(([name, level]) => `${name} → ниво ${level}`),
  ]
    .filter(Boolean)
    .join(' · ');
}

const files = (n: number) => `${n} ${n === 1 ? 'файл' : 'файла'}`;

// Езикът и архитектурата в лентата горе. Менюто показва за всеки избор колко файла би засегнал.
export function Pickers({
  info,
  trial,
  version,
  onTrial,
}: {
  info: DesignInfo;
  trial: Trial | undefined;
  version: number;
  onTrial: (t: Trial) => void;
}) {
  const design = info.design as Design;
  const [open, setOpen] = useState<'stack' | 'style'>();
  const [efforts, setEfforts] = useState<{ styles: Record<string, Effort>; stacks: Record<string, Effort> }>();
  useEffect(() => setEfforts(undefined), [version]);
  useEffect(() => {
    if (!open || efforts) return;
    designEfforts()
      .then(setEfforts)
      .catch(() => undefined);
  }, [open, efforts]);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(undefined);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);
  const style = trial?.style ?? design.style;
  const stack = trial?.stack ?? design.stack;
  const language = info.stacks.find((s) => s.stack === design.stack)?.language;
  const hint = (e: Effort | undefined, now: boolean) =>
    now ? '✓ сега' : !e ? '…' : e.files ? files(e.files) : 'без промени';
  const toggle = (which: 'stack' | 'style') => (ev: React.MouseEvent) => {
    ev.stopPropagation();
    setOpen(open === which ? undefined : which);
  };
  return (
    <div className="pickers">
      <div className={`pick${trial?.stack ? ' trying' : ''}`}>
        <button onClick={toggle('stack')}>
          <small>език</small>
          {info.stacks.find((s) => s.stack === stack)?.label}
        </button>
        {open === 'stack' && (
          <div className="menu">
            <h5>Пробвай с друг език</h5>
            {info.stacks.map((s) => (
              <button
                key={s.stack}
                className={s.stack === stack ? 'now' : ''}
                onClick={() => onTrial({ ...trial, stack: s.stack })}
              >
                <b>{s.label}</b>
                <span>
                  {s.stack === design.stack
                    ? 'записаният'
                    : s.language === language
                      ? 'същият език'
                      : 'всичко се пише наново'}
                </span>
                <em>{hint(efforts?.stacks[s.stack], s.stack === design.stack)}</em>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className={`pick${trial?.style ? ' trying' : ''}`}>
        <button onClick={toggle('style')}>
          <small>архитектура</small>
          {info.styles.find((s) => s.style === style)?.label}
        </button>
        {open === 'style' && (
          <div className="menu">
            <h5>Пробвай с друга архитектура</h5>
            {info.styles.map((s) => (
              <button
                key={s.style}
                className={s.style === style ? 'now' : ''}
                onClick={() => onTrial({ ...trial, style: s.style })}
              >
                <b>{s.label}</b>
                <span>
                  {s.about}
                  {!s.levels && ' · без нива'}
                </span>
                <em>{hint(efforts?.styles[s.style], s.style === design.style)}</em>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ArchitectureView({
  info,
  trial,
  report,
  error,
  onCancel,
  onOpen,
}: {
  info: DesignInfo;
  trial: Trial | undefined;
  report: StatusReport | undefined;
  error: string | undefined;
  onCancel: () => void;
  onOpen: (name: string) => void;
}) {
  const design = info.design as Design;
  const [saving, setSaving] = useState<string>();
  if (error)
    return (
      <div id="stage" className="empty">
        {error}
      </div>
    );
  if (!report)
    return (
      <div id="stage" className="empty">
        Проверявам…
      </div>
    );
  const style = info.styles.find((s) => s.style === (trial?.style ?? design.style));
  const modules = [...new Set([...info.entities, ...report.classes.map((c) => c.module ?? '—')])].filter(
    (m) => report.classes.some((c) => (c.module ?? '—') === m) || report.extra.some((e) => e.module === m),
  );
  const known = new Set(report.layers);
  const rows = [...report.layers, ...(report.classes.some((c) => !known.has(c.layer)) ? ['друго'] : [])];
  const inRow = (c: StatusClass, row: string) => (row === 'друго' ? !known.has(c.layer) : c.layer === row);
  const level = (m: string): Level => trial?.levels?.[m] ?? design.resources?.[m]?.level ?? 3;
  const columns = { gridTemplateColumns: `170px repeat(${modules.length}, minmax(150px, 1fr))` };
  const apply = () => {
    if (!trial) return;
    setSaving('Записвам…');
    saveDesign(applied(design, trial))
      .then(onCancel)
      .catch((e: Error) => setSaving(e.message));
  };
  return (
    <div id="stage" className="arch">
      {trial && (
        <div className="trial">
          <span>
            <b>Проба: {trialLabel(info, trial)}</b> · нищо не е записано
          </span>
          <span className="mono">
            готово {report.done} от {report.total}
            {report.mismatches > 0 && <span className="bad"> · {report.mismatches} несъвпадения</span>}
          </span>
          {report.effort && (
            <span className="mono">
              {report.effort.size} рефакторинг · {files(report.effort.files)}
            </span>
          )}
          <span className="actions">
            {saving && <span className="mono">{saving}</span>}
            <button className="btn" onClick={onCancel}>
              Откажи
            </button>
            <button className="btn pri" onClick={apply} title="записва чертежа; кодът не се пипа">
              Приложи
            </button>
          </span>
        </div>
      )}
      <div className="grid" style={columns}>
        <div />
        {modules.map((m) => {
          const items = report.classes.filter((c) => (c.module ?? '—') === m);
          const bad = items.filter((c) => c.state !== 'ok').length + report.extra.filter((e) => e.module === m).length;
          return (
            <div key={m} className="colhead">
              <b>{m}</b>
              {info.entities.includes(m) && (
                <span className="lvl">{style?.levels ? `ниво ${level(m)}` : 'без нива'}</span>
              )}
              <span>
                {items.length} класа
                {bad > 0 && <span className="bad"> · {bad} за промяна</span>}
              </span>
            </div>
          );
        })}
        {rows.map((row) => (
          <Row key={row} row={row} allow={style?.allow[row]}>
            {modules.map((m) => {
              const items = report.classes.filter((c) => (c.module ?? '—') === m && inRow(c, row));
              return (
                <div key={m} className={items.length ? 'cell' : 'cell empty'}>
                  {items.map((c) => (
                    <Chip
                      key={c.name}
                      item={c}
                      onOpen={trial || c.state === 'missing' || c.state === 'move' ? undefined : onOpen}
                    />
                  ))}
                </div>
              );
            })}
          </Row>
        ))}
      </div>
      {report.extra.length > 0 && (
        <div className="band-extra">
          <h4>
            Излишни за {style?.label}{' '}
            <span>· {report.extra.length} класа, които тази архитектура няма; логиката им отива в новите</span>
          </h4>
          <div className="grid" style={columns}>
            <div className="rowhead">
              <b>от другата</b>
              <span>архитектура или ниво</span>
            </div>
            {modules.map((m) => (
              <div key={m} className="cell">
                {report.extra
                  .filter((e) => e.module === m)
                  .map((e) => (
                    <Chip key={e.name} item={e} />
                  ))}
              </div>
            ))}
          </div>
          {report.extra.some((e) => !e.module || !modules.includes(e.module)) && (
            <div className="cell">
              {report.extra
                .filter((e) => !e.module || !modules.includes(e.module))
                .map((e) => (
                  <Chip key={e.name} item={e} />
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ row, allow, children }: { row: string; allow: string[] | undefined; children: React.ReactNode }) {
  return (
    <>
      <div className="rowhead">
        <b>{row}</b>
        {row !== 'друго' && <span>→ {allow?.length ? allow.join(', ') : 'нищо'}</span>}
      </div>
      {children}
    </>
  );
}

const STATE: Record<string, string> = { missing: 'липсва', move: 'мести се', changed: 'промени' };

function Chip({ item, onOpen }: { item: StatusClass | StatusExtra; onOpen?: ((name: string) => void) | undefined }) {
  const state = 'state' in item ? item.state : 'extra';
  const title =
    'state' in item
      ? item.state === 'move'
        ? `${item.from} → ${item.file}`
        : item.file
      : `${item.file}:${item.line}${item.layer ? ` · слой ${item.layer}` : ''}`;
  return (
    <span
      className={`c ${state}${onOpen ? ' link' : ''}`}
      title={title}
      onClick={onOpen ? () => onOpen(item.name) : undefined}
    >
      <i style={{ background: `var(--r-${item.role}, var(--r-class))` }} />
      <span className="n">{item.name}</span>
      {STATE[state] && <small>{STATE[state]}</small>}
    </span>
  );
}

// Панелът вдясно: усилието за пробата или какво е записаното.
export function ArchitectureAside({
  info,
  trial,
  report,
}: {
  info: DesignInfo;
  trial: Trial | undefined;
  report: StatusReport | undefined;
}) {
  const design = info.design as Design;
  const style = info.styles.find((s) => s.style === (trial?.style ?? design.style));
  const stack = info.stacks.find((s) => s.stack === (trial?.stack ?? design.stack));
  const e = report?.effort;
  return (
    <aside>
      <div className="scroll arch-aside">
        {trial && e ? (
          <section>
            <h3>Усилие за прехода</h3>
            <div className="size">
              {e.size[0]?.toUpperCase()}
              {e.size.slice(1)} рефакторинг
              <small>
                {files(e.files)}
                {e.lines > 0 && ` · около ${e.lines} реда за пренасяне`}
              </small>
            </div>
            <div className="bar">
              <i style={{ flex: e.fresh, background: 'var(--bad)' }} />
              <i style={{ flex: e.moves, background: 'var(--move)' }} />
              <i style={{ flex: e.removed, background: 'var(--gone)' }} />
              <i style={{ flex: e.edited, background: 'var(--sig)' }} />
            </div>
            <ul className="effort">
              <li>
                <i style={{ background: 'var(--bad)' }} />
                <span>нови класа за писане</span>
                <em>
                  {e.fresh}
                  {e.methods > 0 && ` · ${e.methods} метода`}
                </em>
              </li>
              <li>
                <i style={{ background: 'var(--move)' }} />
                <span>класа за местене</span>
                <em>{e.moves}</em>
              </li>
              <li>
                <i style={{ background: 'var(--gone)' }} />
                <span>класа за махане</span>
                <em>
                  {e.removed}
                  {e.lines > 0 && ` · ~${e.lines} реда`}
                </em>
              </li>
              <li>
                <i style={{ background: 'var(--sig)' }} />
                <span>класа за промяна</span>
                <em>{e.edited}</em>
              </li>
            </ul>
          </section>
        ) : (
          <section>
            <h3>
              {style?.label} · {stack?.label}
            </h3>
            {report && (
              <p>
                {report.mismatches === 0
                  ? `Всичко от чертежа е в кода и съвпада: ${report.done} от ${report.total}.`
                  : `Готово ${report.done} от ${report.total}; ${report.mismatches} несъвпадения.`}
              </p>
            )}
            <p className="note">{style?.about}</p>
          </section>
        )}
        <section>
          <h3>Какво значи</h3>
          <div className="key">
            <span>
              <span className="c missing">
                <span className="n">Клас</span>
                <small>липсва</small>
              </span>{' '}
              го няма в кода
            </span>
            <span>
              <span className="c move">
                <span className="n">Клас</span>
                <small>мести се</small>
              </span>{' '}
              същият клас, друга папка
            </span>
            <span>
              <span className="c changed">
                <span className="n">Клас</span>
                <small>промени</small>
              </span>{' '}
              липсват методи или полета, или сигнатурата е друга
            </span>
            <span>
              <span className="c extra">
                <span className="n">Клас</span>
              </span>{' '}
              не е от тази архитектура
            </span>
          </div>
        </section>
        <section>
          {trial ? (
            <>
              <h3>След „Приложи“</h3>
              <p className="note">
                Записва се само чертежът, кодът не се пипа. Агентът пише по скелетите и пуска проверката, докато
                червеното изчезне. „Копирай плана за AI“ вляво дава същия списък като задача.
              </p>
            </>
          ) : (
            <>
              <h3>Пробвай</h3>
              <p className="note">
                Избери друга архитектура или език горе, или друго ниво на ресурс вляво. Нищо не се записва: виждаш какво
                ще се счупи и колко работа е.
              </p>
            </>
          )}
        </section>
      </div>
    </aside>
  );
}

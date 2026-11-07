import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { useState, type CSSProperties } from 'react';
import type { ProcessMember, ProcessNode as Data, Slot } from '@archgraph/engine';

export type FlowNode = Node<{ view: Data; dim: boolean; marked: boolean }, 'process'>;

const VISIBILITY: Record<string, string> = { private: '−', protected: '#' };

// Нодът по mockup-а: заглавие с роля, методите от процеса като редове, параметрите като входове
// отляво, резултатът като изход отдясно. Останалите методи са свити под „още N“.
export function ProcessNode({ data, selected }: NodeProps<FlowNode>) {
  const { view, dim, marked } = data;
  const [more, setMore] = useState(false);
  const classes = ['node', view.kind === 'interface' && 'iface', dim && 'dim', selected && 'sel', marked && 'marked'];
  const role = { '--role': `var(--r-${view.role}, var(--r-class))` } as CSSProperties;
  return (
    <div className={classes.filter(Boolean).join(' ')} style={role}>
      {/* интерфейс ⇒ имплементация: от долния ръб на договора към горния на имплементацията */}
      <Handle type="target" position={Position.Top} id="top" />
      <Handle type="source" position={Position.Bottom} id="bottom" />
      <div className="hd">
        <Handle type="target" position={Position.Left} id="in" />
        <span className="role">{view.role}</span>
        <span className="nm" title={view.name}>
          {view.name}
        </span>
        {view.usedBy.length > 0 && (
          <span className="used" title={`ползва се от ${view.usedBy.length} места в проекта`}>
            ↙{view.usedBy.length}
          </span>
        )}
        <Handle type="source" position={Position.Right} id="out" />
      </div>
      {(view.bases.length > 0 || view.tags.length > 0) && (
        <div className="meta">
          {view.tags.map((t) => (
            <span className="tag" key={t}>
              {t}
            </span>
          ))}
          {view.bases.map((b) => (
            <span key={b.name}>
              {b.kind} <b>{b.name}</b>
            </span>
          ))}
        </div>
      )}
      {view.members.length > 0 && (
        <div className="sec">
          {view.members.map((m) => (
            <MemberRows key={m.name} member={m} />
          ))}
        </div>
      )}
      {view.others.length > 0 && (
        <div className="sec more">
          <div
            className="toggle"
            onClick={(e) => {
              e.stopPropagation();
              setMore(!more);
            }}
          >
            {more ? '▾' : '▸'} още {view.others.length} {view.others.length === 1 ? 'метод' : 'метода'}
          </div>
          {more &&
            view.others.map((m) => (
              <div className="sig mono" key={m.name} title={`ред ${m.line}`}>
                <Marks member={m} />
                {m.name}({m.inputs.map((p) => p.name).join(', ')})
                {m.output && <span className="ty">: {short(m.output.type)}</span>}
              </div>
            ))}
        </div>
      )}
      {view.deps.length > 0 && (
        <div className="sec">
          <div className="t">зависимости</div>
          {view.deps.map((d) => (
            <SlotRow key={d.name} slot={d} side="out" />
          ))}
        </div>
      )}
      {view.fields.length > 0 && (
        <div className="sec">
          <div className="t">полета</div>
          {view.fields.map((f) => (
            <SlotRow key={f.name} slot={f} side="in" />
          ))}
        </div>
      )}
      <div className="ft mono" title={`${view.file}:${view.line}`}>
        {view.file.split('/').at(-1)}:{view.line}
      </div>
    </div>
  );
}

function MemberRows({ member: m }: { member: ProcessMember }) {
  return (
    <div className="m">
      <div className="mn">
        <Handle type="target" position={Position.Left} id={`in-${m.name}`} style={{ left: -11 }} />
        <Marks member={m} />
        {m.name}
        <small>()</small>
        {m.unresolved.length > 0 && (
          <span
            className="warn"
            title={`графът не може да свърже:\n${m.unresolved.map((u) => `${u.name}()  :${u.line}`).join('\n')}`}
          >
            ⚠ {m.unresolved.length}
          </span>
        )}
        {!m.output && <Handle type="source" position={Position.Right} id={`out-${m.name}`} style={{ right: -11 }} />}
      </div>
      {m.inputs.map((p) => (
        <SlotRow key={p.name} slot={p} side="in" />
      ))}
      {m.output && <SlotRow slot={m.output} side="out" handle={`out-${m.name}`} />}
    </div>
  );
}

function Marks({ member: m }: { member: ProcessMember }) {
  return (
    <>
      {VISIBILITY[m.visibility] && (
        <span className="vis" title={m.visibility}>
          {VISIBILITY[m.visibility]}
        </span>
      )}
      {m.static && <small className="kw">static </small>}
      {m.async && <small className="kw">async </small>}
    </>
  );
}

// Порт: име и тип, кръгче с цвета на типа. DTO с полета се разгъва с ▸.
function SlotRow({ slot, side, handle }: { slot: Slot; side: 'in' | 'out'; handle?: string }) {
  const [open, setOpen] = useState(false);
  const color = `var(--t-${slot.kind})`;
  const caret = slot.fields?.length ? (
    <span
      className="caret"
      onClick={(e) => {
        e.stopPropagation();
        setOpen(!open);
      }}
    >
      {open ? '▾' : '▸'}
    </span>
  ) : null;
  return (
    <>
      <div className={`row ${side} mono`}>
        <i className="dot" style={{ background: color }} />
        {side === 'in' ? (
          <>
            {slot.name}
            {slot.optional && <span className="opt">?</span>}
            <span className="ty" style={{ color }} title={slot.type}>
              {short(slot.type)}
            </span>
            {caret}
          </>
        ) : (
          <>
            {caret}
            <span className="ty" style={{ color }} title={slot.type}>
              {short(slot.type)}
            </span>
            {slot.name}
          </>
        )}
        {handle && <Handle type="source" position={Position.Right} id={handle} style={{ right: -15 }} />}
      </div>
      {open && slot.fields && (
        <div className="fields">
          {slot.fields.map((f) => (
            <SlotRow key={f.name} slot={f} side="in" />
          ))}
        </div>
      )}
    </>
  );
}

// `Psr\Http\Message\ServerRequestInterface` → `ServerRequestInterface`; пълното име е в подсказката.
export function short(type: string): string {
  return type.replace(/[\w$]+(?:[\\./#][\w$]+)+/g, (name) => name.split(/[\\./#]/).at(-1) ?? name);
}

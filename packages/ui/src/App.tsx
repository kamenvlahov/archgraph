import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  type Edge,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProcessNode as ProcessNodeView, ProcessView } from '@archgraph/engine';
import { layout } from './layout.ts';
import { ProcessNode, short, type FlowNode } from './ProcessNode.tsx';

interface Entry {
  id: string;
  label: string;
  role: string;
  file: string;
  line: number;
}

const nodeTypes = { process: ProcessNode };
const ROLES = ['route', 'controller', 'service', 'repository', 'interface', 'factory', 'entity', 'dto'];
const LEGEND: [string, string][] = [
  ['primitive', 'примитив'],
  ['dto', 'DTO'],
  ['entity', 'entity'],
  ['collection', 'колекция'],
  ['external', 'външен тип'],
  ['contract', 'договор'],
];

export function App() {
  const [project, setProject] = useState<{ name: string; entries: Entry[] }>();
  const [entry, setEntry] = useState<string>();
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<ProcessView>();
  const [error, setError] = useState<string>();
  const [depth, setDepth] = useState(6);

  useEffect(() => {
    fetch('/api/project')
      .then((r) => r.json())
      .then((p: { name: string; entries: Entry[] }) => {
        setProject(p);
        setEntry(p.entries[0]?.id);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!entry) return;
    fetch(`/api/process?target=${encodeURIComponent(entry)}&depth=${depth}`)
      .then((r) => r.json())
      .then((v: ProcessView & { error?: string }) => (v.error ? setError(v.error) : setView(v)))
      .catch((e: Error) => setError(e.message));
  }, [entry, depth]);

  const shown = (project?.entries ?? []).filter((e) => e.label.toLowerCase().includes(filter.toLowerCase()));
  return (
    <>
      <header>
        <div className="logo">
          arch<b>graph</b>
        </div>
        <div className="proj">{project?.name}</div>
        <div className="chips">
          {ROLES.map((r) => (
            <span className="chip" key={r}>
              <i style={{ background: `var(--r-${r})` }} />
              {r}
            </span>
          ))}
        </div>
        {view && (
          <div className="stats">
            <span>
              {view.nodes.length} нода · {view.edges.length} връзки
            </span>
            <label>
              дълбочина{' '}
              <select value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
                {[2, 3, 4, 6, 8, 12].map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </label>
          </div>
        )}
      </header>
      <nav>
        <h3>Ендпойнти</h3>
        <input placeholder="търси…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <ul>
          {shown.map((e) => (
            <li key={e.id} className={e.id === entry ? 'on' : ''} onClick={() => setEntry(e.id)} title={e.label}>
              <EntryLabel entry={e} />
              <small>
                {e.file}:{e.line}
              </small>
            </li>
          ))}
        </ul>
      </nav>
      <ReactFlowProvider>
        <Process view={view} error={error} />
      </ReactFlowProvider>
    </>
  );
}

function EntryLabel({ entry }: { entry: Entry }) {
  const [method, ...rest] = entry.label.split(' ');
  if (entry.role !== 'route' || !rest.length) return <>{entry.label}</>;
  return (
    <>
      <span className={`method ${method}`}>{method}</span>
      {rest.join(' ')}
    </>
  );
}

function Process({ view, error }: { view: ProcessView | undefined; error: string | undefined }) {
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [selected, setSelected] = useState<string>();
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const initialized = useNodesInitialized();
  const flow = useReactFlow();

  // Нов процес: приблизителни позиции, после истинските след измерване на нодовете.
  useEffect(() => {
    if (!view) return;
    setSelected(undefined);
    setMarked(new Set());
    const positions = layout(view, new Map());
    setNodes(
      view.nodes.map((n) => ({
        id: n.id,
        type: 'process',
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        data: { view: n, dim: false, marked: false },
      })),
    );
  }, [view]);
  // Подреждане по измерените височини: след първото измерване и когато нод смени размера си (▸).
  const relayout = useCallback(() => {
    if (!view) return;
    const heights = new Map(flow.getNodes().map((n) => [n.id, n.measured?.height ?? 0]));
    const positions = layout(view, heights);
    setNodes((ns) => ns.map((n) => ({ ...n, position: positions.get(n.id) ?? n.position })));
  }, [view, flow]);
  useEffect(() => {
    if (!initialized || !view) return;
    relayout();
    // Мащабът не пада под 80%, за да се четат портовете; процесът започва от левия ръб, а остатъкът
    // се вижда с влачене (както в ComfyUI).
    requestAnimationFrame(() => {
      const stage = document.getElementById('stage')?.getBoundingClientRect();
      const bounds = flow.getNodesBounds(flow.getNodes());
      if (!stage || !bounds.width) return;
      const zoom = Math.min(1, Math.max(0.8, (stage.width - 80) / bounds.width));
      const y = bounds.height * zoom < stage.height - 80 ? (stage.height - bounds.height * zoom) / 2 : 40;
      flow.setViewport({ x: 40 - bounds.x * zoom, y: y - bounds.y * zoom, zoom });
    });
  }, [initialized, view, flow, relayout]);

  const neighbours = useMemo(() => {
    if (!selected || !view) return undefined;
    const near = new Set([selected]);
    for (const e of view.edges) {
      if (e.from.node === selected) near.add(e.to.node);
      if (e.to.node === selected) near.add(e.from.node);
    }
    return near;
  }, [selected, view]);

  const shownNodes = nodes.map((n) => ({
    ...n,
    selected: n.id === selected,
    data: { ...n.data, dim: neighbours ? !neighbours.has(n.id) : false, marked: marked.has(n.id) },
  }));
  const roles = new Map(view?.nodes.map((n) => [n.id, n.role]));
  // Връзка в същия нод (`$this->x()`, `new self`) не е проводник: би била примка.
  const edges: Edge[] = (view?.edges ?? [])
    .filter((e) => e.from.node !== e.to.node)
    .map((e) => {
      const vertical = e.kind === 'implements';
      const color = vertical ? 'var(--r-interface)' : `var(--r-${roles.get(e.to.node) ?? 'class'}, var(--r-class))`;
      const dim = neighbours && !(neighbours.has(e.from.node) && neighbours.has(e.to.node));
      return {
        id: e.id,
        // проводниците на избрания нод текат, за да се вижда посоката
        animated: !!selected && (e.from.node === selected || e.to.node === selected),
        source: e.from.node,
        target: e.to.node,
        sourceHandle: vertical ? 'bottom' : e.from.member ? `out-${e.from.member}` : 'out',
        targetHandle: vertical ? 'top' : e.to.member ? `in-${e.to.member}` : 'in',
        style: {
          stroke: color,
          strokeWidth: 2.2,
          opacity: dim ? 0.08 : 0.85,
          strokeDasharray: vertical || e.kind === 'maybe' ? '6 5' : undefined,
        },
      };
    });

  const current = view?.nodes.find((n) => n.id === selected);
  return (
    <>
      <div id="stage">
        {error && <div className="empty">{error}</div>}
        {!error && !view && <div className="empty">Избери ендпойнт отляво</div>}
        {view && (
          <ReactFlow
            nodes={shownNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={(changes) => {
              setNodes((ns) => applyNodeChanges(changes, ns));
              if (initialized && changes.some((c) => c.type === 'dimensions')) requestAnimationFrame(relayout);
            }}
            onNodeClick={(_, n) => setSelected(n.id === selected ? undefined : n.id)}
            onPaneClick={() => setSelected(undefined)}
            minZoom={0.15}
            proOptions={{ hideAttribution: true }}
            colorMode="dark"
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#2a2c31" />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              style={{ width: 150, height: 96 }}
              nodeColor={(n) => `var(--r-${roles.get(n.id) ?? 'class'})`}
            />
          </ReactFlow>
        )}
      </div>
      <Aside view={view} current={current} marked={marked} setMarked={setMarked} />
    </>
  );
}

function Aside({
  view,
  current,
  marked,
  setMarked,
}: {
  view: ProcessView | undefined;
  current: ProcessView['nodes'][number] | undefined;
  marked: Set<string>;
  setMarked: (s: Set<string>) => void;
}) {
  const [task, setTask] = useState('');
  const [plan, setPlan] = useState('');
  const toggle = (id: string) => {
    const next = new Set(marked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setMarked(next);
  };
  // Маркираните нодове влизат в плана с методите, които участват в процеса.
  const makePlan = async () => {
    const targets = (view?.nodes ?? [])
      .filter((n) => marked.has(n.id))
      .flatMap((n) => (n.members.length ? n.members.map((m) => `${n.id}#${m.name}`) : [n.id]));
    const query = new URLSearchParams([['task', task], ...targets.map((t) => ['target', t])]);
    const text = await (await fetch(`/api/plan?${query}`)).text();
    setPlan(text);
    await navigator.clipboard?.writeText(text).catch(() => undefined);
  };
  return (
    <aside>
      <div className="scroll">
        <h3>Нод</h3>
        <div className="insp">
          {current ? (
            <Inspector node={current} marked={marked.has(current.id)} toggle={toggle} />
          ) : (
            <div className="marked">Клик върху нод го фокусира и показва всичко за него.</div>
          )}
        </div>
        <h3>План за AI</h3>
        <div className="plan">
          <div className="marked">
            {marked.size ? `${marked.size} маркирани нода` : 'Маркирай нодовете, които ще се променят.'}
          </div>
          <textarea placeholder="Задачата с думи…" value={task} onChange={(e) => setTask(e.target.value)} />
          <button className="btn pri" disabled={!marked.size || !task.trim()} onClick={makePlan}>
            Копирай плана за AI
          </button>
          {plan && <pre className="mono">{plan}</pre>}
        </div>
      </div>
      <div className="legend">
        {LEGEND.map(([k, label]) => (
          <span key={k}>
            <i style={{ background: `var(--t-${k})` }} />
            {label}
          </span>
        ))}
      </div>
    </aside>
  );
}

// Всичко за избрания нод: роля, място, наследяване, всички методи (участващите в процеса са ярки),
// полета, зависимости и кой го ползва в целия проект.
function Inspector({ node, marked, toggle }: { node: ProcessNodeView; marked: boolean; toggle: (id: string) => void }) {
  const [copied, setCopied] = useState(false);
  const where = `${node.file}:${node.line}`;
  const copy = () => {
    void navigator.clipboard?.writeText(where).then(() => setCopied(true));
    setTimeout(() => setCopied(false), 1200);
  };
  const methods = [...node.members.map((m) => [m, true] as const), ...node.others.map((m) => [m, false] as const)];
  return (
    <>
      <div className="big">{node.name}</div>
      <div className="badges">
        <span className="role" style={{ background: `var(--r-${node.role}, var(--r-class))` }}>
          {node.role}
        </span>
        {node.tags.map((t) => (
          <span className="tag" key={t}>
            {t}
          </span>
        ))}
      </div>
      <div className="loc mono" onClick={copy} title="копирай пътя">
        {copied ? 'копирано' : where}
      </div>
      {node.bases.map((b) => (
        <div className="meta" key={b.name}>
          {b.kind} <b>{b.name}</b>
        </div>
      ))}
      {methods.length > 0 && (
        <>
          <h4>Методи ({methods.length})</h4>
          <div className="list mono">
            {methods.map(([m, inProcess]) => (
              <div key={m.name} className={inProcess ? 'on' : 'off'} title={inProcess ? 'участва в процеса' : ''}>
                {m.visibility !== 'public' ? `${m.visibility} ` : ''}
                {m.static ? 'static ' : ''}
                {m.name}({m.inputs.map((p) => `${p.name}: ${short(p.type)}`).join(', ')})
                {m.output ? `: ${short(m.output.type)}` : ''}
                <span className="where">:{m.line}</span>
                {m.unresolved.length > 0 && <span className="warn">⚠ {m.unresolved.length}</span>}
              </div>
            ))}
          </div>
        </>
      )}
      {node.deps.length > 0 && (
        <>
          <h4>Зависимости</h4>
          <div className="list mono">
            {node.deps.map((d) => (
              <div key={d.name} className="on">
                {d.name}: {d.type}
              </div>
            ))}
          </div>
        </>
      )}
      {node.fields.length > 0 && (
        <>
          <h4>Полета</h4>
          <div className="list mono">
            {node.fields.map((f) => (
              <div key={f.name} className="on">
                {f.name}
                {f.optional ? '?' : ''}: {short(f.type)}
              </div>
            ))}
          </div>
        </>
      )}
      <h4>Ползва се от ({node.usedBy.length})</h4>
      <div className="list mono">
        {node.usedBy.length === 0 && <div className="off">никой в проекта (или по низ, което графът не вижда)</div>}
        {node.usedBy.slice(0, 30).map((u) => (
          <div key={`${u.kind} ${u.label}`} className="off" title={`${u.file}:${u.line}`}>
            <span className="on">{u.label}</span>
            <span className="where">{u.kind}</span>
          </div>
        ))}
        {node.usedBy.length > 30 && <div className="off">… още {node.usedBy.length - 30}</div>}
      </div>
      <div className="btns">
        <button className="btn" onClick={() => toggle(node.id)}>
          {marked ? 'Махни от плана' : 'Добави в плана'}
        </button>
      </div>
    </>
  );
}

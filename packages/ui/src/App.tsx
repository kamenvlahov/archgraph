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
  type Node,
  type NodeChange,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProcessNode as ProcessNodeView, ProcessView } from '@archgraph/engine';
import { createPlan, get, inEditor, onChange, openInEditor } from './api.ts';
import { layout, NODE_WIDTH, type Lane } from './layout.ts';
import { LayerView } from './LayerView.tsx';
import { ProcessNode, short, type FlowNode } from './ProcessNode.tsx';

interface Entry {
  id: string;
  label: string;
  role: string;
  file: string;
  line: number;
}

const nodeTypes = { process: ProcessNode, lane: LaneNode };
const LANE = 'lane:';

// Лентите са фонови нодове под процеса: по една за слой, през всички колони.
function laneNodes(bands: Lane[], nodes: FlowNode[]): Node[] {
  const right = Math.max(0, ...nodes.map((n) => n.position.x)) + NODE_WIDTH;
  return bands.map((b) => {
    const size = { width: right + 140, height: b.height + 68 };
    // размерът е известен, затова и измерването: иначе React Flow крие нода и чака да го измери
    return {
      id: `${LANE}${b.name}`,
      type: 'lane',
      position: { x: -70, y: b.y - 34 },
      data: { name: b.name },
      style: size,
      measured: size,
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: -1,
    };
  });
}

function LaneNode({ data }: { data: { name: string } }) {
  return (
    <div className="lane">
      <span>{data.name}</span>
    </div>
  );
}
const LAYERS = ['presentation', 'application', 'domain', 'infrastructure', 'composition'];

interface RoleInfo {
  layer: string;
  color: string;
}

// Редът на слоевете отвън навътре; роли без слой (class, function) са последни.
function layerIndex(catalog: Record<string, RoleInfo>, role: string): number {
  const i = LAYERS.indexOf(catalog[role]?.layer ?? '');
  return i < 0 ? LAYERS.length : i;
}
const LEGEND: [string, string][] = [
  ['primitive', 'примитив'],
  ['dto', 'DTO'],
  ['entity', 'entity'],
  ['collection', 'колекция'],
  ['external', 'външен тип'],
  ['contract', 'договор'],
];

export function App() {
  const [project, setProject] = useState<{ name: string; entries: Entry[]; layers: string[] }>();
  const [lanes, setLanes] = useState(true); // ленти по слой
  const [layer, setLayer] = useState<string>(); // изгледът „цял слой“ вместо процес
  const [layerList, setLayerList] = useState<{ name: string; units: number }[]>([]);
  // ендпойнт, клас или метод: процесът от него (и излизане от изгледа на слой)
  const openProcess = (id: string) => {
    setLayer(undefined);
    setEntry(id);
  };
  const [version, setVersion] = useState(0); // расте при промяна на файл в проекта
  const [entry, setEntry] = useState<string>();
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<ProcessView>();
  const [error, setError] = useState<string>();
  const [depth, setDepth] = useState(6);
  const [found, setFound] = useState<Entry[]>([]);
  const [catalog, setCatalog] = useState<Record<string, RoleInfo>>({});

  // Цветовете на ролите идват от каталога (packages/rules/catalog.yaml) като CSS променливи.
  useEffect(() => {
    get<Record<string, RoleInfo>>('/api/roles')
      .then((roles) => {
        for (const [role, info] of Object.entries(roles))
          document.documentElement.style.setProperty(`--r-${role}`, info.color);
        setCatalog(roles);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    Promise.all([get<{ name: string; layers: string[] }>('/api/project'), get<Entry[]>('/api/endpoints')])
      .then(([p, entries]) => {
        setProject({ name: p.name, entries, layers: p.layers });
        setEntry((current) => current ?? entries[0]?.id);
      })
      .catch((e: Error) => setError(e.message));
  }, [version]);
  useEffect(() => onChange(() => setVersion((v) => v + 1)), []);
  useEffect(() => {
    get<{ name: string; units: number }[]>('/api/layers')
      .then(setLayerList)
      .catch(() => setLayerList([]));
  }, [version]);
  useEffect(() => {
    if (!entry) return;
    get<ProcessView>(`/api/processes/${encodeURIComponent(entry)}?depth=${depth}`)
      .then((v) => {
        setError(undefined);
        setView(v);
      })
      .catch((e: Error) => setError(e.message));
  }, [entry, depth, version]);

  // Търсенето показва и класове и методи: начало на процес, когато ендпойнтът липсва.
  useEffect(() => {
    if (filter.trim().length < 2) {
      setFound([]);
      return;
    }
    const timer = setTimeout(() => {
      get<Entry[]>(`/api/search?q=${encodeURIComponent(filter)}`)
        .then(setFound)
        .catch(() => setFound([]));
    }, 150);
    return () => clearTimeout(timer);
  }, [filter]);

  const shown = (project?.entries ?? []).filter((e) => e.label.toLowerCase().includes(filter.toLowerCase()));
  return (
    <>
      <header>
        <div className="logo">
          arch<b>graph</b>
        </div>
        <div className="proj">{project?.name}</div>
        {/* ролите в показания процес, по слоеве отвън навътре */}
        <div className="chips">
          {[...new Set(layer ? [] : view?.nodes.map((n) => n.role))]
            .sort((a, b) => layerIndex(catalog, a) - layerIndex(catalog, b) || a.localeCompare(b))
            .map((r) => (
              <span className="chip" key={r} title={catalog[r]?.layer}>
                <i style={{ background: `var(--r-${r}, var(--r-class))` }} />
                {r}
              </span>
            ))}
        </div>
        {view && !layer && (
          <div className="stats">
            <span>
              {view.nodes.length} нода · {view.edges.length} връзки
            </span>
            <label>
              <input type="checkbox" checked={lanes} onChange={(e) => setLanes(e.target.checked)} /> слоеве
            </label>
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
        <input placeholder="ендпойнт, клас или метод…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {layerList.length > 0 && (
          <>
            <h3>Слоеве</h3>
            <ul>
              {layerList.map((l) => (
                <li key={l.name} className={l.name === layer ? 'on' : ''} onClick={() => setLayer(l.name)}>
                  {l.name}
                  <small>{l.units} класа и файла</small>
                </li>
              ))}
            </ul>
          </>
        )}
        <h3>Ендпойнти</h3>
        {shown.length === 0 && (
          <div className="hint">
            {project?.entries.length ? 'няма съвпадения' : 'няма намерени ендпойнти; потърси клас или метод'}
          </div>
        )}
        <ul>
          {shown.map((e) => (
            <li
              key={e.id}
              className={e.id === entry && !layer ? 'on' : ''}
              onClick={() => openProcess(e.id)}
              title={e.label}
            >
              <EntryLabel entry={e} />
              <small>
                {e.file}:{e.line}
              </small>
            </li>
          ))}
        </ul>
        {found.length > 0 && (
          <>
            <h3>Класове и методи</h3>
            <ul>
              {found.map((e) => (
                <li
                  key={e.id}
                  className={e.id === entry && !layer ? 'on' : ''}
                  onClick={() => openProcess(e.id)}
                  title={e.label}
                >
                  <i className="dot-role" style={{ background: `var(--r-${e.role}, var(--r-class))` }} />
                  {e.label}
                  <small>
                    {e.file}:{e.line}
                  </small>
                </li>
              ))}
            </ul>
          </>
        )}
      </nav>
      <ReactFlowProvider key={layer ? `layer:${layer}` : 'process'}>
        {layer ? (
          <LayerView layer={layer} onProcess={openProcess} />
        ) : (
          <Process view={view} error={error} lanes={lanes ? project?.layers : undefined} />
        )}
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

function Process({
  view,
  error,
  lanes,
}: {
  view: ProcessView | undefined;
  error: string | undefined;
  lanes: string[] | undefined;
}) {
  const [bands, setBands] = useState<Lane[]>([]);
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [selected, setSelected] = useState<string>();
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const initialized = useNodesInitialized();
  const flow = useReactFlow();

  // Нов процес: приблизителни позиции, после истинските след измерване на нодовете. Същият процес
  // след промяна на файл пази избора, маркираните и изгледа на екрана.
  const shownTitle = useRef<string>(undefined);
  const sameProcess = view?.title === shownTitle.current;
  useEffect(() => {
    if (!view) return;
    if (view.title !== shownTitle.current) {
      setSelected(undefined);
      setMarked(new Set());
    }
    const { positions } = layout(view, new Map(), lanes);
    setNodes(
      view.nodes.map((n) => ({
        id: n.id,
        type: 'process',
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        data: { view: n, dim: false, marked: false },
      })),
    );
  }, [view, lanes]);
  // Подреждане по измерените височини: след първото измерване и когато нод смени размера си (▸).
  const relayout = useCallback(() => {
    if (!view) return;
    const heights = new Map(flow.getNodes().map((n) => [n.id, n.measured?.height ?? 0]));
    const placed = layout(view, heights, lanes);
    setNodes((ns) => ns.map((n) => ({ ...n, position: placed.positions.get(n.id) ?? n.position })));
    setBands(placed.lanes);
  }, [view, flow, lanes]);
  useEffect(() => {
    if (!initialized || !view) return;
    relayout();
    if (sameProcess) return;
    shownTitle.current = view.title;
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
  }, [initialized, view, flow, relayout, sameProcess]);

  // Курсорът в редактора (VS Code) маркира нода, ако е в процеса.
  useEffect(() => {
    const reveal = (e: MessageEvent<{ type?: string; file?: string; line?: number }>) => {
      if (e.data.type !== 'reveal') return;
      get<{ node: string }>(`/api/nodes?file=${encodeURIComponent(e.data.file ?? '')}&line=${e.data.line ?? 0}`)
        .then(({ node }) => {
          if (!view?.nodes.some((n) => n.id === node)) return;
          setSelected(node);
          const n = flow.getNode(node);
          if (n)
            flow.setCenter(n.position.x + 145, n.position.y + (n.measured?.height ?? 0) / 2, {
              duration: 300,
              zoom: flow.getZoom(),
            });
        })
        .catch(() => undefined);
    };
    window.addEventListener('message', reveal);
    return () => window.removeEventListener('message', reveal);
  }, [view, flow]);

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
      const color = e.violation
        ? 'var(--bad)'
        : vertical
          ? 'var(--r-interface)'
          : `var(--r-${roles.get(e.to.node) ?? 'class'}, var(--r-class))`;
      const dim = neighbours && !(neighbours.has(e.from.node) && neighbours.has(e.to.node));
      return {
        id: e.id,
        // проводниците на избрания нод текат, за да се вижда посоката
        animated: !!selected && (e.from.node === selected || e.to.node === selected),
        source: e.from.node,
        target: e.to.node,
        sourceHandle: vertical ? 'bottom' : e.from.member ? `out-${e.from.member}` : 'out',
        targetHandle: vertical ? 'top' : e.to.member ? `in-${e.to.member}` : 'in',
        // нарушение на слой или контекст: червен проводник с ⚠ и съобщението в подсказка
        ...(e.violation
          ? { label: '⚠', labelStyle: { fill: 'var(--bad)' }, labelBgStyle: { fill: 'var(--panel)' } }
          : {}),
        style: {
          stroke: color,
          strokeWidth: e.violation ? 3 : 2.2,
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
            nodes={[...laneNodes(bands, nodes), ...shownNodes]}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={(changes) => {
              setNodes((ns) =>
                applyNodeChanges(
                  changes.filter((c) => !('id' in c) || !c.id.startsWith(LANE)) as NodeChange<FlowNode>[],
                  ns,
                ),
              );
              if (initialized && changes.some((c) => c.type === 'dimensions')) requestAnimationFrame(relayout);
            }}
            onNodeClick={(_, n) => !n.id.startsWith(LANE) && setSelected(n.id === selected ? undefined : n.id)}
            onNodeDoubleClick={(_, n) => {
              const v = view.nodes.find((x) => x.id === n.id);
              if (v) openInEditor(v.file, v.line);
            }}
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
    const text = await createPlan(task, targets);
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
  // Във VS Code отваря файла; в браузъра копира пътя.
  const copy = () => {
    if (inEditor) return openInEditor(node.file, node.line);
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
        {node.layer && <span className="layer">{node.layer}</span>}
      </div>
      <div className="loc mono" onClick={copy} title={inEditor ? 'отвори' : 'копирай пътя'}>
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
              <div
                key={m.name}
                className={`${inProcess ? 'on' : 'off'}${inEditor ? ' link' : ''}`}
                title={inProcess ? 'участва в процеса' : ''}
                onClick={() => openInEditor(node.file, m.line)}
              >
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
      {node.violations.length > 0 && (
        <>
          <h4 className="bad">Нарушения ({node.violations.length})</h4>
          <div className="list">
            {node.violations.map((v) => (
              <div key={v} className="bad">
                {v}
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

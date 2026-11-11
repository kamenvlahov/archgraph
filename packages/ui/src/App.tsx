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
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ProcessNode as ProcessNodeView, ProcessView } from '@archgraph/engine';
import {
  createPattern,
  createPlan,
  designStatus,
  get,
  inEditor,
  onChange,
  openInEditor,
  trialQuery,
  type DesignInfo,
  type Shape,
  type StatusReport,
  type Trial,
} from './api.ts';
import { ArchitectureAside, ArchitectureView, cleanTrial, Pickers, TrialBanner } from './Architecture.tsx';
import { DesignNav, DesignStart, EndpointEditor, Layers, removeEndpoint, routeKey } from './Design.tsx';
import { layout, NODE_WIDTH, type Lane } from './layout.ts';
import { LayerView } from './LayerView.tsx';
import { routeTree, type RouteGroup } from './routes.ts';
import { ProcessNode, short, type FlowNode } from './ProcessNode.tsx';

interface Entry {
  id: string;
  label: string;
  role: string;
  file: string;
  line: number;
  ghost?: boolean; // от чертежа, още го няма в кода
  trial?: Record<string, number>; // при проба: колко класа във веригата липсват, се местят, се променят, се махат
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
  const [project, setProject] = useState<{
    name: string;
    entries: Entry[];
    layers: string[];
    files: Record<string, number>;
  }>();
  const [design, setDesign] = useState<DesignInfo>(); // чертежът (етап 11)
  const [pending, setPending] = useState<string>(); // току-що добавеният ендпойнт: отваря се, щом дойде
  const [lanes, setLanes] = useState(true); // ленти по слой
  const [layer, setLayer] = useState<string>(); // изгледът „цял слой“ вместо процес
  const [layerList, setLayerList] = useState<{ name: string; units: number }[]>([]);
  const [shaped, setShaped] = useState<{ result: Shape; example: string }>(); // шаблон „като този“
  // Изгледът „Архитектура“ и пробата в него: друг стил, стек или ниво, без запис.
  const [arch, setArch] = useState(false);
  const [trial, setTrial] = useState<Trial>();
  const [report, setReport] = useState<StatusReport>();
  const [reportError, setReportError] = useState<string>();
  const startTrial = (t: Trial) => {
    if (!design?.design) return;
    setTrial(cleanTrial(t, design.design));
    setArch(true);
  };
  // ендпойнт, клас или метод: процесът от него в таба „Граф“; пробата остава за таба „Архитектура“
  const openProcess = (id: string) => {
    setArch(false);
    setLayer(undefined);
    setShaped(undefined);
    setEntry(id);
  };
  const openLayer = (name: string) => {
    setArch(false);
    setShaped(undefined);
    setLayer(name);
  };
  const startPattern = (example: string, to: string) => {
    setError(undefined);
    createPattern(example, to)
      .then((result) => setShaped({ result, example }))
      .catch((e: Error) => setError(e.message));
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
    Promise.all([
      get<{ name: string; layers: string[]; files: Record<string, number> }>('/api/project'),
      get<Entry[]>('/api/endpoints'),
      get<DesignInfo>('/api/design'),
    ])
      .then(([p, entries, d]) => {
        setProject({ name: p.name, entries, layers: p.layers, files: p.files });
        setDesign(d);
        setEntry((current) => (current && entries.some((e) => e.id === current) ? current : entries[0]?.id));
      })
      .catch((e: Error) => setError(e.message));
  }, [version]);
  useEffect(() => {
    const added = pending && project?.entries.find((e) => routeKey(e.label) === pending);
    if (!added) return;
    setPending(undefined);
    openProcess(added.id);
  }, [pending, project]);
  useEffect(() => onChange(() => setVersion((v) => v + 1)), []);
  const trialKey = JSON.stringify(trial ?? {});
  const hasDesign = !!design?.design;
  useEffect(() => {
    if (!hasDesign || (!arch && trialKey === '{}')) return;
    setReport(undefined);
    designStatus(JSON.parse(trialKey) as Trial)
      .then((r) => {
        setReportError(undefined);
        setReport(r);
      })
      .catch((e: Error) => setReportError(e.message));
  }, [arch, hasDesign, trialKey, version]);
  // Шаблонът се преизчислява при промяна на файл: вече създаденото е истински нод, не ghost.
  const shapedExample = shaped?.example;
  const shapedTo = shaped?.result.to;
  useEffect(() => {
    if (!shapedExample || !shapedTo || version === 0) return;
    createPattern(shapedExample, shapedTo)
      .then((result) => setShaped({ result, example: shapedExample }))
      .catch(() => undefined);
  }, [version, shapedExample, shapedTo]);
  useEffect(() => {
    get<{ name: string; units: number }[]>('/api/layers')
      .then(setLayerList)
      .catch(() => setLayerList([]));
  }, [version]);
  useEffect(() => {
    if (!entry) return;
    // при проба процесът е по проверявания чертеж
    const trying = trialKey === '{}' ? '' : `&${trialQuery(JSON.parse(trialKey) as Trial)}`;
    get<ProcessView>(`/api/processes/${encodeURIComponent(entry)}?depth=${depth}${trying}`)
      .then((v) => {
        setError(undefined);
        setView(v);
      })
      .catch((e: Error) => setError(e.message));
  }, [entry, depth, version, trialKey]);
  // При проба ендпойнтите вляво носят броячите си: какво трябва да стане във веригата на всеки.
  const [counts, setCounts] = useState<Map<string, Record<string, number>>>();
  useEffect(() => {
    if (trialKey === '{}') return setCounts(undefined);
    get<Entry[]>(`/api/endpoints?${trialQuery(JSON.parse(trialKey) as Trial)}`)
      .then((entries) => setCounts(new Map(entries.map((e) => [e.id, e.trial ?? {}]))))
      .catch(() => setCounts(undefined));
  }, [trialKey, version]);

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
  // Празна папка без чертеж: изборът на стек и архитектура.
  if (project && design && !design.design && Object.keys(project.files).length === 0)
    return (
      <>
        <header>
          <div className="logo">
            arch<b>graph</b>
          </div>
          <div className="proj">{project.name}</div>
        </header>
        <DesignStart info={design} />
      </>
    );
  const style = design?.styles.find((s) => s.style === design.design?.style);
  const blank = !!design?.design && !project?.entries.length;
  const label = project?.entries.find((e) => e.id === entry && e.role === 'route')?.label;
  return (
    <>
      <header>
        <div className="logo">
          arch<b>graph</b>
        </div>
        <div className="proj">{project?.name}</div>
        {design?.design && <Pickers info={design} trial={trial} version={version} onTrial={startTrial} />}
        {design?.design && (
          <div className="tabs">
            <button type="button" className={arch ? 'on' : ''} onClick={() => setArch(true)}>
              Архитектура
              {trial && <i title="неприложена проба" />}
            </button>
            <button type="button" className={arch ? '' : 'on'} onClick={() => setArch(false)}>
              Граф
            </button>
          </div>
        )}
        {/* ролите в показания процес, по слоеве отвън навътре */}
        <div className="chips">
          {[...new Set(layer || arch ? [] : (shaped?.result.view ?? view)?.nodes.map((n) => n.role))]
            .sort((a, b) => layerIndex(catalog, a) - layerIndex(catalog, b) || a.localeCompare(b))
            .map((r) => (
              <span className="chip" key={r} title={catalog[r]?.layer}>
                <i style={{ background: `var(--r-${r}, var(--r-class))` }} />
                {r}
              </span>
            ))}
        </div>
        {view && !layer && !shaped && !arch && (
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
        {design?.design && (
          <DesignNav
            info={design}
            onAdded={(m, p) => setPending(routeKey(`${m} ${p}`))}
            levels={trial?.levels}
            onLevel={(name, level) => startTrial({ ...trial, levels: { ...trial?.levels, [name]: level } })}
          />
        )}
        <input placeholder="ендпойнт, клас или метод…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {layerList.length > 0 && (
          <>
            <h3>Слоеве</h3>
            <ul>
              {layerList.map((l) => (
                <li key={l.name} className={l.name === layer && !arch ? 'on' : ''} onClick={() => openLayer(l.name)}>
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
        <RouteList
          entries={shown}
          current={layer || arch ? undefined : entry}
          open={filter !== ''}
          onOpen={openProcess}
          onRemove={design?.design ? (e) => void removeEndpoint(design, e.label) : undefined}
          counts={counts}
        />
        {found.length > 0 && (
          <>
            <h3>Класове и методи</h3>
            <ul>
              {found.map((e) => (
                <li
                  key={e.id}
                  className={e.id === entry && !layer && !arch ? 'on' : ''}
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
      {arch && design?.design ? (
        <>
          <ArchitectureView
            info={design}
            trial={trial}
            report={report}
            error={reportError}
            onCancel={() => setTrial(undefined)}
            onOpen={openProcess}
          />
          <ArchitectureAside info={design} trial={trial} report={report} />
        </>
      ) : (
        <ReactFlowProvider key={shaped ? 'pattern' : layer ? `layer:${layer}` : 'process'}>
          <PatternStart.Provider value={startPattern}>
            {shaped ? (
              <Process
                key={shaped.result.view.title}
                view={shaped.result.view}
                error={error}
                lanes={lanes ? project?.layers : undefined}
                aside={<PatternPanel shape={shaped.result} onBack={() => setShaped(undefined)} />}
              />
            ) : layer ? (
              <LayerView layer={layer} onProcess={openProcess} />
            ) : blank && style ? (
              <div id="stage">
                <div className="blank">
                  <h2>Слоевете на {style.label}</h2>
                  <p>{style.about}</p>
                  <Layers style={style} />
                  <p>
                    Добави първия ендпойнт горе вляво, например <code>POST /invoices</code>.
                  </p>
                </div>
              </div>
            ) : (
              <Process
                view={view}
                error={error}
                lanes={lanes ? (trial ? report?.layers : project?.layers) : undefined}
                banner={
                  trial && design?.design ? (
                    <TrialBanner info={design} trial={trial} report={report} onCancel={() => setTrial(undefined)} />
                  ) : undefined
                }
                top={
                  design?.design && label ? (
                    <EndpointEditor
                      key={label}
                      info={design}
                      label={label}
                      onSaved={(m, p) => setPending(routeKey(`${m} ${p}`))}
                    />
                  ) : undefined
                }
              />
            )}
          </PatternStart.Provider>
        </ReactFlowProvider>
      )}
    </>
  );
}

// Ендпойнтите като дърво по пътя (routes.ts). Малкият списък е разгънат; големият е свит, освен
// групата на избрания ендпойнт и всичко при търсене. Кликът обръща това, което е по подразбиране.
function RouteList({
  entries,
  current,
  open,
  onOpen,
  onRemove,
  counts,
}: {
  entries: Entry[];
  current: string | undefined;
  open: boolean;
  onOpen: (id: string) => void;
  onRemove: ((entry: Entry) => void) | undefined; // ендпойнтите от чертежа се махат с ✕
  counts: Map<string, Record<string, number>> | undefined; // при проба
}) {
  const [flipped, setFlipped] = useState(new Set<string>());
  const tree = useMemo(() => routeTree(entries), [entries]);
  const few = tree.count <= 30;
  const has = (g: RouteGroup<Entry>): boolean => g.leaves.some((l) => l.entry.id === current) || g.groups.some(has);
  const toggle = (key: string) =>
    setFlipped((f) => {
      const next = new Set(f);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const render = (g: RouteGroup<Entry>) => (
    <ul>
      {g.leaves.map((l) => (
        <li
          key={l.entry.id}
          className={[l.entry.id === current && 'on', l.entry.ghost && 'ghost'].filter(Boolean).join(' ')}
          onClick={() => onOpen(l.entry.id)}
          title={`${l.entry.label}\n${l.entry.ghost ? 'още го няма в кода' : `${l.entry.file}:${l.entry.line}`}`}
        >
          <EntryLabel entry={l.entry} name={l.name} />
          {counts && <TrialCounts counts={counts.get(l.entry.id) ?? {}} />}
          {onRemove && l.entry.ghost && (
            <span
              className="x"
              title="махни от чертежа"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(l.entry);
              }}
            >
              ✕
            </span>
          )}
        </li>
      ))}
      {g.groups.map((sub) => {
        const shown = (open || few || has(sub)) !== flipped.has(sub.key);
        return (
          <li key={sub.key} className="crumbs">
            <div onClick={() => toggle(sub.key)} title={sub.key}>
              <span className="chev">{shown ? '▾' : '▸'}</span>
              {sub.crumbs.map((c, i) => (
                <span key={i}>
                  {i > 0 && <i>›</i>}
                  {c}
                </span>
              ))}
              <small>{sub.count}</small>
            </div>
            {shown && render(sub)}
          </li>
        );
      })}
    </ul>
  );
  return render(tree);
}

const COUNTS: [string, string][] = [
  ['missing', 'нови'],
  ['move', 'мести се'],
  ['changed', 'промени'],
  ['extra', 'махат се'],
];
// Броячите на ендпойнт при проба; без нищо за правене е ✓.
function TrialCounts({ counts }: { counts: Record<string, number> }) {
  const shown = COUNTS.filter(([k]) => counts[k]);
  if (!shown.length) return <span className="counts ok">✓</span>;
  return (
    <span className="counts">
      {shown.map(([k, label]) => (
        <span key={k} className={k} title={`${counts[k]} ${label}`}>
          {counts[k]}
        </span>
      ))}
    </span>
  );
}

function EntryLabel({ entry, name }: { entry: Entry; name: string }) {
  const [method, ...rest] = entry.label.split(' ');
  if (entry.role !== 'route' || !rest.length) return <>{entry.label}</>;
  return (
    <>
      <span className={`method ${method}`}>{method}</span>
      {name}
    </>
  );
}

function Process({
  view,
  error,
  lanes,
  aside,
  top,
  banner,
}: {
  view: ProcessView | undefined;
  error: string | undefined;
  lanes: string[] | undefined;
  aside?: ReactNode; // друг панел вдясно (шаблон „като този“)
  top?: ReactNode; // над нода в десния панел (ендпойнтът от чертежа)
  banner?: ReactNode; // лентата на пробата над графа
}) {
  const [bands, setBands] = useState<Lane[]>([]);
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [selected, setSelected] = useState<string>();
  const initialized = useNodesInitialized();
  const flow = useReactFlow();

  // Нов процес: приблизителни позиции, после истинските след измерване на нодовете. Същият процес
  // след промяна на файл пази избора, маркираните и изгледа на екрана.
  const shownTitle = useRef<string>(undefined);
  const sameProcess = view?.title === shownTitle.current;
  useEffect(() => {
    if (!view) return;
    if (view.title !== shownTitle.current) setSelected(undefined);
    const { positions } = layout(view, new Map(), lanes);
    setNodes(
      view.nodes.map((n) => ({
        id: n.id,
        type: 'process',
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        data: { view: n, dim: false },
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
    data: { ...n.data, dim: neighbours ? !neighbours.has(n.id) : false },
  }));
  const roles = new Map(view?.nodes.map((n) => [n.id, n.role]));
  // Връзка в същия нод (`$this->x()`, `new self`) не е проводник: би била примка.
  const edges: Edge[] = (view?.edges ?? [])
    .filter((e) => e.from.node !== e.to.node)
    .map((e) => {
      const vertical = e.kind === 'implements';
      // при проба: новата връзка е червен пунктир, отпадащата — бледи точки
      const color = e.violation
        ? 'var(--bad)'
        : e.kind === 'requests'
          ? 'var(--r-route)'
          : e.trial === 'new'
            ? 'var(--bad)'
            : e.trial === 'gone'
              ? 'var(--gone)'
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
        // HTTP заявка към route (етап 12), може и в друга услуга
        ...(e.kind === 'requests'
          ? { label: 'HTTP', labelStyle: { fill: 'var(--r-route)' }, labelBgStyle: { fill: 'var(--panel)' } }
          : {}),
        ...(e.violation
          ? { label: '⚠', labelStyle: { fill: 'var(--bad)' }, labelBgStyle: { fill: 'var(--panel)' } }
          : {}),
        style: {
          stroke: color,
          strokeWidth: e.violation ? 3 : 2.2,
          opacity: dim ? 0.08 : e.trial === 'gone' ? 0.6 : 0.85,
          strokeDasharray:
            e.kind === 'requests'
              ? '10 5'
              : e.trial === 'new'
                ? '7 5'
                : e.trial === 'gone'
                  ? '2 5'
                  : vertical || e.kind === 'maybe'
                    ? '6 5'
                    : undefined,
        },
      };
    });

  const current = view?.nodes.find((n) => n.id === selected);
  return (
    <>
      <div id="stage">
        {banner}
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
      {aside ?? <Aside view={view} current={current} top={top} />}
    </>
  );
}

function Aside({
  view,
  current,
  top,
}: {
  view: ProcessView | undefined;
  current: ProcessView['nodes'][number] | undefined;
  top: ReactNode;
}) {
  const nodes = view?.nodes ?? [];
  return (
    <aside>
      <div className="scroll">
        {top}
        <h3>Нод</h3>
        <div className="insp">
          {current ? (
            <Inspector node={current} />
          ) : (
            <>
              <div className="marked">Клик върху нод го фокусира и показва всичко за него.</div>
              {nodes.length > 0 && (
                <div className="btns">
                  <CopyForAI label="Копирай процеса за AI" nodes={nodes} />
                </div>
              )}
            </>
          )}
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
// Контекстът за AI агент: сигнатурите, кой вика и от какво зависят нодовете (POST /api/plans).
// Задачата пишеш в чата с агента, над поставения текст.
function CopyForAI({ label, nodes }: { label: string; nodes: ProcessNodeView[] }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    const targets = nodes.flatMap((n) => (n.members.length ? n.members.map((m) => `${n.id}#${m.name}`) : [n.id]));
    await navigator.clipboard?.writeText(await createPlan('', targets)).catch(() => undefined);
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <button className="btn" onClick={() => void copy()} title="задачата пиши в чата с AI-а, над поставения текст">
      {done ? 'Копирано' : label}
    </button>
  );
}

function Inspector({ node }: { node: ProcessNodeView }) {
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
        <CopyForAI label="Копирай за AI" nodes={[node]} />
      </div>
      <SameFor example={node.id} />
    </>
  );
}

// „Направи същото за…“: шаблон по образеца на този клас или функция (етап 8).
export const PatternStart = createContext<(example: string, to: string) => void>(() => undefined);

export function SameFor({ example }: { example: string }) {
  const start = useContext(PatternStart);
  const [name, setName] = useState('');
  return (
    <form
      className="same"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) start(example, name.trim());
      }}
    >
      <input placeholder="Направи същото за… (напр. Invoice)" value={name} onChange={(e) => setName(e.target.value)} />
      <button className="btn" disabled={!name.trim()}>
        Покажи
      </button>
    </form>
  );
}

// Шаблонът: новите файлове, регистрациите и планът. Ghost нодовете са в процеса вляво.
function PatternPanel({ shape, onBack }: { shape: Shape; onBack: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <aside>
      <div className="scroll">
        <h3>Шаблон</h3>
        <div className="insp">
          <div className="big">{shape.view.title}</div>
          <div className="meta">
            <b>{shape.from}</b> → <b>{shape.to}</b> във всички форми. Пунктирните нодове още ги няма в кода; когато
            файлът се появи, нодът става истински.
          </div>
          <div className="btns">
            <button className="btn" onClick={onBack}>
              ← обратно
            </button>
            <button
              className="btn pri"
              onClick={() => void navigator.clipboard?.writeText(shape.plan).then(() => setCopied(true))}
            >
              {copied ? 'Копирано' : 'Копирай плана за AI'}
            </button>
          </div>
          <h4>Нови ({shape.ghosts.length})</h4>
          <div className="list mono">
            {shape.ghosts.map((g) => (
              <div key={g.id} className="on" title={`образец: ${g.exampleFile}`}>
                {g.name}
                <span className="where">{g.file}</span>
              </div>
            ))}
          </div>
          {shape.registrations.length > 0 && (
            <>
              <h4>Регистрации ({shape.registrations.length})</h4>
              <div className="list mono">
                {shape.registrations.map((r) => (
                  <div key={`${r.file}:${r.line}`} className="on link" onClick={() => openInEditor(r.file, r.line)}>
                    {r.suggested}
                    <span className="where">
                      {r.file}:{r.line}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

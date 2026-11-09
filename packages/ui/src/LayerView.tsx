import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';
import type { LayerView as Data, Unit } from '@archgraph/engine';
import { get, openInEditor } from './api.ts';
import { SameFor } from './App.tsx';

// Целият слой по модули: групите са ленти, а в тях класовете (или файловете с функции) са компактни
// карти в решетка. Стрелките са само вътре в слоя; ↑/↓ са връзките с другите слоеве.

const W = 240;
const H = 66;
const GAP_X = 50;
const GAP_Y = 34;
const PER_ROW = 5;
const PAD = 46;

type UnitNode = Node<{ unit: Unit; dim: boolean }, 'unit'>;
type GroupNode = Node<{ name: string }, 'module'>;
// `module`, а не `group`: React Flow има вграден стил за нод от тип `group`
const nodeTypes = { unit: UnitCard, module: GroupLane };

export function LayerView({ layer, onProcess }: { layer: string; onProcess: (target: string) => void }) {
  const [view, setView] = useState<Data>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const flow = useReactFlow();

  useEffect(() => {
    setSelected(undefined);
    get<Data>(`/api/layers/${encodeURIComponent(layer)}`)
      .then((v) => {
        setError(undefined);
        setView(v);
      })
      .catch((e: Error) => setError(e.message));
  }, [layer]);

  // Групите една под друга, единиците в решетка по PER_ROW на ред.
  const { nodes, groups } = useMemo(() => {
    const nodes: UnitNode[] = [];
    const groups: GroupNode[] = [];
    let y = 0;
    for (const g of view?.groups ?? []) {
      const rows = Math.ceil(g.units.length / PER_ROW);
      const width = Math.min(g.units.length, PER_ROW) * (W + GAP_X) - GAP_X + PAD * 2;
      const height = rows * (H + GAP_Y) - GAP_Y + PAD + 30;
      groups.push({
        id: `group:${g.name}`,
        type: 'module',
        position: { x: 0, y },
        data: { name: g.name },
        style: { width, height },
        measured: { width, height },
        draggable: false,
        selectable: false,
        zIndex: -1,
      });
      g.units.forEach((unit, i) =>
        nodes.push({
          id: unit.id,
          type: 'unit',
          position: { x: PAD + (i % PER_ROW) * (W + GAP_X), y: y + 40 + Math.floor(i / PER_ROW) * (H + GAP_Y) },
          data: { unit, dim: false },
        }),
      );
      y += height + 40;
    }
    return { nodes, groups };
  }, [view]);

  useEffect(() => {
    if (nodes.length) requestAnimationFrame(() => flow.fitView({ padding: 0.06, maxZoom: 1 }));
  }, [nodes, flow]);

  const near = useMemo(() => {
    if (!selected || !view) return undefined;
    const set = new Set([selected]);
    for (const e of view.edges) {
      if (e.from === selected) set.add(e.to);
      if (e.to === selected) set.add(e.from);
    }
    return set;
  }, [selected, view]);

  const roles = new Map(nodes.map((n) => [n.id, n.data.unit.role]));
  const edges: Edge[] = (view?.edges ?? []).map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    ...(e.count > 1
      ? { label: String(e.count), labelStyle: { fill: 'var(--muted)' }, labelBgStyle: { fill: 'var(--panel)' } }
      : {}),
    animated: !!selected && (e.from === selected || e.to === selected),
    style: {
      stroke: e.violation ? 'var(--bad)' : `var(--r-${roles.get(e.to) ?? 'class'}, var(--r-class))`,
      strokeWidth: e.violation ? 3 : 1.8,
      opacity: near && !(near.has(e.from) && near.has(e.to)) ? 0.06 : 0.75,
    },
  }));
  const shown = nodes.map((n) => ({
    ...n,
    selected: n.id === selected,
    data: { ...n.data, dim: !!near && !near.has(n.id) },
  }));
  const current = view?.groups.flatMap((g) => g.units).find((u) => u.id === selected);

  return (
    <>
      <div id="stage">
        {error && <div className="empty">{error}</div>}
        {view && (
          <ReactFlow
            nodes={[...groups, ...shown]}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, n) => !n.id.startsWith('group:') && setSelected(n.id === selected ? undefined : n.id)}
            onPaneClick={() => setSelected(undefined)}
            nodesDraggable={false}
            minZoom={0.1}
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
      <aside>
        <div className="scroll">
          <h3>Слой {layer}</h3>
          <div className="insp">
            {current ? (
              <UnitPanel unit={current} onProcess={onProcess} />
            ) : (
              <div className="marked">
                {view?.groups.reduce((a, g) => a + g.units.length, 0)} единици в {view?.groups.length} модула. Клик
                върху карта показва методите ѝ; клик върху метод отваря процеса от него.
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}

function UnitPanel({ unit, onProcess }: { unit: Unit; onProcess: (target: string) => void }) {
  return (
    <>
      <div className="big">{unit.label}</div>
      <div className="badges">
        <span className="role" style={{ background: `var(--r-${unit.role}, var(--r-class))` }}>
          {unit.role}
        </span>
      </div>
      <div className="loc mono link" onClick={() => openInEditor(unit.file, unit.line)}>
        {unit.file}:{unit.line}
      </div>
      <div className="meta">
        ↑ {unit.up} зависят от него от други слоеве · ↓ {unit.down} зависимости в други слоеве
      </div>
      {unit.violations.length > 0 && (
        <>
          <h4 className="bad">Нарушения ({unit.violations.length})</h4>
          <div className="list">
            {unit.violations.map((v) => (
              <div key={v} className="bad">
                {v}
              </div>
            ))}
          </div>
        </>
      )}
      {unit.members[0] && <SameFor example={unit.id.startsWith('file:') ? unit.members[0].target : unit.id} />}
      <h4>
        {unit.id.startsWith('file:') ? 'Функции' : 'Методи'} ({unit.members.length}) — клик за процеса
      </h4>
      <div className="list mono">
        {unit.members.map((m) => (
          <div key={m.target} className="on link" onClick={() => onProcess(m.target)}>
            {m.name}()<span className="where">:{m.line}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function UnitCard({ data, selected }: NodeProps<UnitNode>) {
  const { unit, dim } = data;
  return (
    <div className={`unit${dim ? ' dim' : ''}${selected ? ' sel' : ''}`} style={{ width: W, height: H }}>
      <Handle type="target" position={Position.Left} />
      <div className="hd" style={{ '--role': `var(--r-${unit.role}, var(--r-class))` } as React.CSSProperties}>
        <span className="role">{unit.role}</span>
        <span className="nm" title={unit.label}>
          {unit.label}
        </span>
        {unit.violations.length > 0 && <span className="bad">⚠ {unit.violations.length}</span>}
      </div>
      <div className="ub mono">
        <span>
          {unit.members.length} {unit.id.startsWith('file:') ? 'функции' : 'метода'}
        </span>
        <span title="зависят от него от други слоеве · зависимости в други слоеве">
          ↑{unit.up} ↓{unit.down}
        </span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function GroupLane({ data }: NodeProps<GroupNode>) {
  return (
    <div className="lane">
      <span>{data.name}</span>
    </div>
  );
}

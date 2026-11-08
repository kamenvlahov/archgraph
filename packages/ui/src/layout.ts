import type { ProcessView } from '@archgraph/engine';

// Процесът се подрежда на колони отляво надясно по дълбочина. В колоната нодовете вървят по средната
// височина на тези, които ги викат (по-малко кръстосани проводници), а имплементацията е веднага под
// договора си. Височините са измерените от React Flow, а преди първото измерване са приблизителни.

export const NODE_WIDTH = 290;
const COLUMN_GAP = 110;
const ROW_GAP = 36;
const LANE_GAP = 70;
export const OTHER = 'друго';

export interface Lane {
  name: string;
  y: number;
  height: number;
}

// С `lanes` процесът е на хоризонтални ленти по слой (отвън навътре), а колоните остават по дълбочина.
// Route-ът е в първата лента; нод без слой е в последната, „друго“.
export function layout(
  view: ProcessView,
  heights: Map<string, number>,
  lanes?: string[],
): { positions: Map<string, { x: number; y: number }>; lanes: Lane[] } {
  const callers = new Map<string, string[]>();
  const implOf = new Map<string, string>();
  for (const e of view.edges) {
    if (e.kind === 'implements') implOf.set(e.to.node, e.from.node);
    else callers.set(e.to.node, [...(callers.get(e.to.node) ?? []), e.from.node]);
  }
  const laneOf = (n: ProcessView['nodes'][number]) => {
    if (!lanes) return '';
    if (n.kind === 'route') return lanes[0] ?? OTHER;
    return n.layer && lanes.includes(n.layer) ? n.layer : OTHER;
  };
  const column = columnsOf(view);
  const height = (n: ProcessView['nodes'][number]) => heights.get(n.id) || estimate(n);
  // позициите вътре в лентата; отместването на лентата се знае едва накрая
  const relative = new Map<string, { col: number; y: number; lane: string }>();
  const bottom = new Map<string, number>();
  const byLane = Map.groupBy(view.nodes, laneOf);
  for (const [lane, inLane] of byLane) {
    const columns = Map.groupBy(inLane, (n) => column.get(n.id) ?? n.column);
    for (const col of [...columns.keys()].sort((a, b) => a - b)) {
      const nodes = columns.get(col) ?? [];
      const order = new Map(nodes.map((n, i) => [n.id, i]));
      const center = (id: string) => {
        const ys = (callers.get(id) ?? []).flatMap((c) => {
          const p = relative.get(c);
          const n = view.nodes.find((x) => x.id === c);
          return p && p.lane === lane && n ? [p.y + height(n) / 2] : [];
        });
        // без извикващ в лентата (той е в друга лента): без предпочитание, веднага след предишния
        return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : undefined;
      };
      const key = (id: string) => center(id) ?? (order.get(id) ?? 0) * 1e6;
      const sorted = nodes.filter((n) => !implOf.has(n.id)).sort((a, b) => key(a.id) - key(b.id));
      // Имплементациите след договора си; ако договорът е в друга колона или лента, в края.
      for (const n of nodes.filter((n) => implOf.has(n.id))) {
        const at = sorted.findIndex((x) => x.id === implOf.get(n.id));
        sorted.splice(at < 0 ? sorted.length : at + 1, 0, n);
      }
      let y = 0;
      for (const n of sorted) {
        // Нодът се стреми към височината на извикващите си, но не застъпва предишния.
        const c = center(n.id);
        const wanted = implOf.has(n.id) || c === undefined ? y : Math.max(y, c - height(n) / 2);
        relative.set(n.id, { col, y: wanted, lane });
        y = wanted + height(n) + ROW_GAP;
      }
      bottom.set(lane, Math.max(bottom.get(lane) ?? 0, y - ROW_GAP));
    }
  }
  const order = lanes ? [...lanes, OTHER] : [''];
  const result: Lane[] = [];
  let offset = 0;
  for (const name of order) {
    if (!byLane.has(name)) continue;
    const h = bottom.get(name) ?? 0;
    result.push({ name, y: offset, height: h });
    offset += h + LANE_GAP;
  }
  const offsets = new Map(result.map((l) => [l.name, l.y]));
  const positions = new Map(
    [...relative].map(([id, p]) => [id, { x: p.col * (NODE_WIDTH + COLUMN_GAP), y: (offsets.get(p.lane) ?? 0) + p.y }]),
  );
  return { positions, lanes: lanes ? result : [] };
}

// Всеки нод е вдясно от всички, които го викат (най-дългият път), за да не се връщат проводници
// наляво. Имплементацията остава в колоната на договора. Цикли не растат безкрайно: спира след N кръга.
function columnsOf(view: ProcessView): Map<string, number> {
  const column = new Map(view.nodes.map((n) => [n.id, n.column]));
  for (let round = 0; round < view.nodes.length; round++) {
    let changed = false;
    for (const e of view.edges) {
      if (e.from.node === e.to.node) continue;
      const from = column.get(e.from.node) ?? 0;
      const wanted = e.kind === 'implements' ? from : from + 1;
      if ((column.get(e.to.node) ?? 0) < wanted) {
        column.set(e.to.node, wanted);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return column;
}

function estimate(n: ProcessView['nodes'][number]): number {
  const rows = n.members.reduce((a, m) => a + 1 + m.inputs.length + (m.output ? 1 : 0), 0);
  return (
    40 + rows * 20 + (n.deps.length ? 24 + n.deps.length * 20 : 0) + (n.fields.length ? 24 + n.fields.length * 20 : 0)
  );
}

import type { ProcessView } from '@archgraph/engine';

// Процесът се подрежда на колони отляво надясно по дълбочина. В колоната нодовете вървят по средната
// височина на тези, които ги викат (по-малко кръстосани проводници), а имплементацията е веднага под
// договора си. Височините са измерените от React Flow, а преди първото измерване са приблизителни.

export const NODE_WIDTH = 290;
const COLUMN_GAP = 110;
const ROW_GAP = 36;

export function layout(view: ProcessView, heights: Map<string, number>): Map<string, { x: number; y: number }> {
  const callers = new Map<string, string[]>();
  const implOf = new Map<string, string>();
  for (const e of view.edges) {
    if (e.kind === 'implements') implOf.set(e.to.node, e.from.node);
    else callers.set(e.to.node, [...(callers.get(e.to.node) ?? []), e.from.node]);
  }
  const column = columnsOf(view);
  const columns = Map.groupBy(view.nodes, (n) => column.get(n.id) ?? n.column);
  const positions = new Map<string, { x: number; y: number }>();
  for (const col of [...columns.keys()].sort((a, b) => a - b)) {
    const nodes = columns.get(col) ?? [];
    const order = new Map(nodes.map((n, i) => [n.id, i]));
    const center = (id: string) => {
      const ys = (callers.get(id) ?? []).flatMap((c) => {
        const p = positions.get(c);
        return p ? [p.y + (heights.get(c) ?? 0) / 2] : [];
      });
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : (order.get(id) ?? 0) * 1000;
    };
    const sorted = nodes.filter((n) => !implOf.has(n.id)).sort((a, b) => center(a.id) - center(b.id));
    // Имплементациите след договора си; ако договорът е в друга колона, в края.
    for (const n of nodes.filter((n) => implOf.has(n.id))) {
      const at = sorted.findIndex((x) => x.id === implOf.get(n.id));
      sorted.splice(at < 0 ? sorted.length : at + 1, 0, n);
    }
    let y = 0;
    for (const n of sorted) {
      // Нодът се стреми към височината на извикващите си, но не застъпва предишния.
      const wanted = implOf.has(n.id) ? y : Math.max(y, center(n.id) - (heights.get(n.id) ?? estimate(n)) / 2);
      positions.set(n.id, { x: col * (NODE_WIDTH + COLUMN_GAP), y: wanted });
      y = wanted + (heights.get(n.id) ?? estimate(n)) + ROW_GAP;
    }
  }
  return positions;
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

import { expect, test } from 'vitest';
import { routeTree, type RouteGroup } from './routes.ts';

const e = (label: string) => ({ label });
// дървото като редове: група → `admin › profile (3)`, ендпойнт → отместен `GET edit`
const lines = (g: RouteGroup<{ label: string }>, depth = 0): string[] => [
  ...g.leaves.map(
    (l) => `${'  '.repeat(depth)}${l.name === l.entry.label ? '' : `${l.entry.label.split(' ')[0]} `}${l.name}`,
  ),
  ...g.groups.flatMap((s) => [`${'  '.repeat(depth)}${s.crumbs.join(' › ')} (${s.count})`, ...lines(s, depth + 1)]),
];

test('общото начало на пътя е група, а самият път на групата е `/`', () => {
  const tree = routeTree([
    e('GET /admin/profile/edit'),
    e('GET /admin/profile/view'),
    e('GET /admin/profile/'),
    e('POST /admin/profile/edit'),
  ]);
  expect(lines(tree)).toEqual(['admin › profile (4)', '  GET /', '  GET edit', '  POST edit', '  GET view']);
});

test('група с един ендпойнт се разгъва в родителя, а без ендпойнти се слива с подгрупата', () => {
  const tree = routeTree([
    e('GET /'),
    e('GET /orders'),
    e('GET /orders/{id}'),
    e('GET /admin/users/list'),
    e('GET /admin/reports/daily'),
    e('GET /health/live'),
  ]);
  expect(lines(tree)).toEqual([
    'GET /',
    'GET health/live',
    'admin (2)',
    '  GET reports/daily',
    '  GET users/list',
    'orders (2)',
    '  GET /',
    '  GET {id}',
  ]);
  expect(tree.count).toBe(6);
});

test('входове без път остават най-отгоре', () => {
  expect(lines(routeTree([e('page admin'), e('GET /a')]))).toEqual(['GET a', 'page admin']);
});

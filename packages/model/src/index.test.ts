import { expect, test } from 'vitest';
import { MODEL_VERSION } from './index.ts';

test('model version', () => {
  expect(MODEL_VERSION).toBe(1);
});

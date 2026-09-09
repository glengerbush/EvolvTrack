import { describe, expect, it } from 'vitest';
import { getGraphPaperMetrics } from './graphPaper';

describe('getGraphPaperMetrics', () => {
  it.each([1, 1.1, 1.25, 1.5, 2, 3])(
    'maps the graph paper to whole device pixels at DPR %s',
    (devicePixelRatio) => {
      const metrics = getGraphPaperMetrics(devicePixelRatio);

      expect(metrics.cellPixels).toBe(Math.round(30 * devicePixelRatio));
      expect(metrics.linePixels).toBe(Math.max(1, Math.round(devicePixelRatio)));
      expect(metrics.inverseScale * devicePixelRatio).toBeCloseTo(1);
    },
  );

  it('falls back safely when the reported scale is invalid', () => {
    expect(getGraphPaperMetrics(0)).toEqual(getGraphPaperMetrics(1));
    expect(getGraphPaperMetrics(Number.NaN)).toEqual(getGraphPaperMetrics(1));
  });
});

const GRID_CELL_CSS_PIXELS = 30;

export type GraphPaperMetrics = {
  scale: number;
  inverseScale: number;
  cellPixels: number;
  linePixels: number;
};

/**
 * Express the grid in physical-pixel SVG units. Scaling the SVG back to CSS
 * space keeps every line and repeat boundary on a whole device pixel.
 */
export function getGraphPaperMetrics(devicePixelRatio: number): GraphPaperMetrics {
  const scale = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;

  return {
    scale,
    inverseScale: 1 / scale,
    cellPixels: Math.max(1, Math.round(GRID_CELL_CSS_PIXELS * scale)),
    linePixels: Math.max(1, Math.round(scale)),
  };
}

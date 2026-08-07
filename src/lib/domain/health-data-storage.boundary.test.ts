import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'test' ? [] : productionSources(path);
    }
    if (!/\.(ts|svelte)$/.test(entry.name) || /\.(test|spec)\.ts$/.test(entry.name)) return [];
    return [path];
  });
}

describe('Health Data Storage boundary', () => {
  it('owns all production Health Entry, Vial, and profile table access', () => {
    const sourceRoot = join(process.cwd(), 'src');
    const storagePath = join(sourceRoot, 'lib/domain/health-data-storage.ts');
    const violations = productionSources(sourceRoot)
      .filter((path) => path !== storagePath)
      .flatMap((path) => readFileSync(path, 'utf8').split('\n').flatMap((line, index) =>
        /\bdb\.(entries|prescriptions|profile)\b/.test(line)
          ? [`${relative(process.cwd(), path)}:${index + 1}`]
          : []
      ));

    expect(violations).toEqual([]);
  });
});

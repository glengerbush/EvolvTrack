import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function productionSources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return productionSources(path);
    if (!/\.(ts|svelte)$/.test(name) || /\.(test|spec)\.ts$/.test(name)) return [];
    return [path];
  });
}

describe('Device Data Erasure ownership', () => {
  it('is the sole production owner of whole-app destructive storage calls', () => {
    const sourceRoot = join(process.cwd(), 'src');
    const violations = productionSources(sourceRoot)
      .filter((path) => relative(sourceRoot, path) !== 'lib/security/device-data-erasure.ts')
      .filter((path) => !relative(sourceRoot, path).startsWith('test/'))
      .filter((path) => {
        const source = readFileSync(path, 'utf8');
        return (
          /\bdb\.delete\s*\(/.test(source) ||
          /indexedDB\.deleteDatabase\s*\(/.test(source) ||
          /localStorage\.clear\s*\(/.test(source) ||
          /sessionStorage\.clear\s*\(/.test(source)
        );
      })
      .map((path) => relative(sourceRoot, path));

    expect(violations).toEqual([]);
  });
});

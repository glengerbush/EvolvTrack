// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dateStamp, downloadBlob, downloadBytes, downloadText } from './download';

describe('dateStamp', () => {
  it('formats a date as YYYY-MM-DD', () => {
    expect(dateStamp(new Date('2026-05-10T12:34:56.000Z'))).toBe('2026-05-10');
  });

  it('defaults to today and returns an ISO date key shape', () => {
    expect(dateStamp()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// downloadBlob/downloadText/downloadBytes touch the DOM (document.createElement,
// .body.append, URL.createObjectURL). happy-dom provides all three, but we
// override them per-test so we can capture the synthetic anchor click() and
// the blob URL the helper minted, rather than letting them no-op against the
// real happy-dom window.
type StubAnchor = {
  href: string;
  download: string;
  rel: string;
  click: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

describe('download helpers', () => {
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  const appended: StubAnchor[] = [];
  let originalCreate: typeof URL.createObjectURL;
  let originalRevoke: typeof URL.revokeObjectURL;
  let originalDocument: unknown;

  beforeEach(() => {
    createdUrls.length = 0;
    revokedUrls.length = 0;
    appended.length = 0;
    originalCreate = URL.createObjectURL;
    originalRevoke = URL.revokeObjectURL;
    originalDocument = (globalThis as Record<string, unknown>).document;

    URL.createObjectURL = vi.fn((_blob: Blob) => {
      const url = `blob:test/${createdUrls.length}`;
      createdUrls.push(url);
      return url;
    }) as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn((url: string) => {
      revokedUrls.push(url);
    }) as unknown as typeof URL.revokeObjectURL;

    (globalThis as Record<string, unknown>).document = {
      createElement: (_tag: string): StubAnchor => ({
        href: '',
        download: '',
        rel: '',
        click: vi.fn(),
        remove: vi.fn(),
      }),
      body: {
        append: (node: StubAnchor) => {
          appended.push(node);
        },
      },
    };
  });

  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    if (originalDocument === undefined) {
      delete (globalThis as Record<string, unknown>).document;
    } else {
      (globalThis as Record<string, unknown>).document = originalDocument;
    }
  });

  it('downloadBlob creates an anchor, clicks it, and revokes the URL', () => {
    const blob = new Blob(['hello'], { type: 'text/plain' });
    downloadBlob(blob, 'hello.txt');

    expect(createdUrls).toHaveLength(1);
    expect(appended).toHaveLength(1);
    const anchor = appended[0];
    expect(anchor.download).toBe('hello.txt');
    expect(anchor.href).toBe(createdUrls[0]);
    expect(anchor.rel).toBe('noopener');
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
    expect(revokedUrls).toEqual(createdUrls);
  });

  it('downloadText wraps the text in a Blob with the given mime type', async () => {
    let captured: Blob | null = null;
    (URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce((b: Blob) => {
      captured = b;
      return 'blob:text';
    });
    downloadText('{"hello":1}', 'a.json', 'application/json');
    expect(captured).not.toBeNull();
    expect(captured!.type).toBe('application/json');
    expect(await captured!.text()).toBe('{"hello":1}');
  });

  it('downloadBytes copies bytes into a Blob with the given mime type', async () => {
    let captured: Blob | null = null;
    (URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce((b: Blob) => {
      captured = b;
      return 'blob:bytes';
    });
    const bytes = new Uint8Array([72, 105]); // "Hi"
    downloadBytes(bytes, 'a.bin', 'application/octet-stream');
    expect(captured).not.toBeNull();
    expect(captured!.type).toBe('application/octet-stream');
    expect(captured!.size).toBe(2);
    expect(await captured!.text()).toBe('Hi');
  });
});
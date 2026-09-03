import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Guards on the dispatch poll itself — the fan-out from an account-wide `.HDD`
 * file onto individual order lines.
 *
 * The parser has its own tests; this covers the things that only go wrong once
 * a file meets a database: collecting only files whose `.DONE` sentinel exists,
 * attributing each record to the right line, surviving a record for a line we
 * do not have, and not re-applying a file we have already read.
 */

// ── SFTP double ──────────────────────────────────────────────────────────────
// A tiny in-memory HOMEDISP. `deleted` is what proves we clean up after
// ourselves, which the spec makes our responsibility.
let remoteFiles: Record<string, string> = {};
let listing: { name: string; type: string }[] = [];
const deleted: string[] = [];

vi.mock('../services/gardners-dropship/connection.service', () => ({
  HOME_DELIVERY_DIRS: { order: 'HOMEORD', ack: 'HOMEACK', dispatch: 'HOMEDISP', general: 'HOMEGEN', preDispatch: 'HOMEPRE' },
  isDropshipSftpBlocked: () => false,
  withDropshipSftp: async (fn: (client: unknown) => Promise<unknown>) =>
    fn({
      list: async () => listing,
      get: async (path: string) => Buffer.from(remoteFiles[path.split('/').pop() ?? ''] ?? '', 'ascii'),
      delete: async (path: string) => {
        deleted.push(path);
      },
    }),
}));

// ── Database double ──────────────────────────────────────────────────────────
// Order lines that exist, keyed by id, and the writes the poll performs.
let existingLines: { id: number; orderId: number }[] = [];
let insertConflicts = false;
const insertedDispatches: Record<string, unknown>[] = [];
const lineStatusUpdates: unknown[] = [];

vi.mock('../db', () => {
  const selectChain = () => {
    const chain = {
      from: () => chain,
      where: () => chain,
      limit: async () => existingLines,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(existingLines).then(resolve),
    };
    return chain;
  };

  return {
    db: {
      select: () => selectChain(),
      insert: () => ({
        values: (values: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              if (insertConflicts) return [];
              insertedDispatches.push(values);
              return [{ id: insertedDispatches.length }];
            },
          }),
        }),
      }),
      update: () => ({
        set: (values: unknown) => ({
          where: async () => {
            lineStatusUpdates.push(values);
          },
        }),
      }),
    },
  };
});

import { gardnersDropshipOrderService } from '../services/gardners-dropship/order.service';

const detail = (uniqueRef: number, dispatchNo: number, tracking: string) =>
  `"DETAIL",${dispatchNo},${String(uniqueRef).padStart(9, '0')},"A","B",1,"9780340911709",1,` +
  `"17/01/2020",799,290,4400,"Dispatched Royal Mail 48 Tracked","Contact Royal Mail On:",` +
  `"www.royalmail.com/track-your-item","Tracking Number: ${tracking}"`;

const file = (...details: string[]) =>
  ['"HEADER","ACC123","01/01/2020"', ...details, `"TRAILER",${details.length}`].join('\r\n') + '\r\n';

beforeEach(() => {
  remoteFiles = {};
  listing = [];
  deleted.length = 0;
  existingLines = [];
  insertConflicts = false;
  insertedDispatches.length = 0;
  lineStatusUpdates.length = 0;
});

describe('pollDispatches', () => {
  it('collects a ready file and applies its records', async () => {
    remoteFiles['00000001.HDD'] = file(detail(11, 900, 'AAA111'));
    listing = [
      { name: '00000001.HDD', type: '-' },
      { name: '00000001.HDD.DONE', type: '-' },
    ];
    existingLines = [{ id: 11, orderId: 5 }];

    const outcome = await gardnersDropshipOrderService.pollDispatches();

    expect(outcome.filesProcessed).toBe(1);
    expect(outcome.recordsRead).toBe(1);
    expect(outcome.recordsApplied).toBe(1);
    expect(outcome.unmatched).toBe(0);
    expect(outcome.dispatched[0]).toMatchObject({
      orderLineId: 11,
      dropshipOrderId: 5,
      carrier: 'Royal Mail',
      trackingNumber: 'AAA111',
      trackingUrl: 'https://www.royalmail.com/track-your-item',
    });
  });

  it('ignores a file whose .DONE sentinel is absent', async () => {
    // Gardners may still be writing it. Reading early is the exact problem the
    // sentinel exists to prevent.
    remoteFiles['00000001.HDD'] = file(detail(11, 900, 'AAA111'));
    listing = [{ name: '00000001.HDD', type: '-' }];
    existingLines = [{ id: 11, orderId: 5 }];

    const outcome = await gardnersDropshipOrderService.pollDispatches();

    expect(outcome.filesProcessed).toBe(0);
    expect(insertedDispatches).toHaveLength(0);
    expect(deleted).toHaveLength(0);
  });

  it('deletes both the file and its sentinel once read', async () => {
    remoteFiles['00000001.HDD'] = file(detail(11, 900, 'AAA111'));
    listing = [
      { name: '00000001.HDD', type: '-' },
      { name: '00000001.HDD.DONE', type: '-' },
    ];
    existingLines = [{ id: 11, orderId: 5 }];

    await gardnersDropshipOrderService.pollDispatches();

    expect(deleted).toContain('HOMEDISP/00000001.HDD');
    expect(deleted).toContain('HOMEDISP/00000001.HDD.DONE');
  });

  it('counts a record for an unknown line as unmatched instead of throwing', async () => {
    // Gardners keeps files for 30 days, so a stale file naming a line we no
    // longer have is plausible. It must not cost us the rest of the file.
    remoteFiles['00000001.HDD'] = file(detail(11, 900, 'AAA111'), detail(99, 901, 'BBB222'));
    listing = [
      { name: '00000001.HDD', type: '-' },
      { name: '00000001.HDD.DONE', type: '-' },
    ];
    existingLines = [{ id: 11, orderId: 5 }];

    const outcome = await gardnersDropshipOrderService.pollDispatches();

    expect(outcome.recordsRead).toBe(2);
    expect(outcome.recordsApplied).toBe(1);
    expect(outcome.unmatched).toBe(1);
  });

  it('treats an already-recorded dispatch as a no-op', async () => {
    // The unique index arbitrates; a redelivered file must not double-ship.
    insertConflicts = true;
    remoteFiles['00000001.HDD'] = file(detail(11, 900, 'AAA111'));
    listing = [
      { name: '00000001.HDD', type: '-' },
      { name: '00000001.HDD.DONE', type: '-' },
    ];
    existingLines = [{ id: 11, orderId: 5 }];

    const outcome = await gardnersDropshipOrderService.pollDispatches();

    expect(outcome.recordsRead).toBe(1);
    expect(outcome.recordsApplied).toBe(0);
    expect(outcome.dispatched).toHaveLength(0);
    expect(lineStatusUpdates).toHaveLength(0);
  });

  it('advances the line status when a dispatch is newly recorded', async () => {
    remoteFiles['00000001.HDD'] = file(detail(11, 900, 'AAA111'));
    listing = [
      { name: '00000001.HDD', type: '-' },
      { name: '00000001.HDD.DONE', type: '-' },
    ];
    existingLines = [{ id: 11, orderId: 5 }];

    await gardnersDropshipOrderService.pollDispatches();

    expect(lineStatusUpdates).toHaveLength(1);
    expect(lineStatusUpdates[0]).toMatchObject({ status: 'fulfilled' });
  });

  it('reads several files in one run', async () => {
    remoteFiles['00000001.HDD'] = file(detail(11, 900, 'AAA111'));
    remoteFiles['00000002.HDD'] = file(detail(12, 901, 'BBB222'));
    listing = [
      { name: '00000001.HDD', type: '-' },
      { name: '00000001.HDD.DONE', type: '-' },
      { name: '00000002.HDD', type: '-' },
      { name: '00000002.HDD.DONE', type: '-' },
    ];
    existingLines = [
      { id: 11, orderId: 5 },
      { id: 12, orderId: 6 },
    ];

    const outcome = await gardnersDropshipOrderService.pollDispatches();

    expect(outcome.filesProcessed).toBe(2);
    expect(outcome.recordsApplied).toBe(2);
    // Two different customer orders, which is the normal shape of a dispatch batch.
    expect(new Set(outcome.dispatched.map((d) => d.dropshipOrderId))).toEqual(new Set([5, 6]));
  });

  it('does nothing when HOMEDISP is empty', async () => {
    const outcome = await gardnersDropshipOrderService.pollDispatches();
    expect(outcome).toMatchObject({ filesProcessed: 0, recordsRead: 0, recordsApplied: 0 });
  });

  it('skips directories that happen to end in .HDD', async () => {
    listing = [
      { name: 'archive.HDD', type: 'd' },
      { name: 'archive.HDD.DONE', type: '-' },
    ];
    const outcome = await gardnersDropshipOrderService.pollDispatches();
    expect(outcome.filesProcessed).toBe(0);
  });
});

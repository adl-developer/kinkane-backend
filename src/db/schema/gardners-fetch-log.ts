/**
 * Gardners Books wholesaler feed ingestion tables — owned by the server
 * (migrations run here). The onix_ingester service reads/writes these
 * tables but does NOT migrate them.
 */
import { pgTable, pgEnum, serial, integer, varchar, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const gardnersFeedEnum = pgEnum('gardners_feed', [
  'inventory',
  'biblio_delta',
  'biblio_full',
  'avail13',
  'promotions',
  'firm_sale',
  'isbn_slips',
  'market_restrictions',
  'regions',
  'covers_full',
  'covers_update',
  'covers_instock',
]);

export const gardnersFetchStatusEnum = pgEnum('gardners_fetch_status', [
  'downloading',
  'processing',
  'completed',
  'failed',
]);

// One record per remote file fetched from Gardners — the idempotency guard
// (feed, remotePath) stops crons from re-processing an unchanged daily/weekly
// full-replace file, and totalChunks/processedChunks doubles as the chunked
// worker's progress tracker (see onix_ingester's gardners-file.worker.ts /
// gardners-chunk.worker.ts).
export const gardnersFetchLog = pgTable(
  'gardners_fetch_log',
  {
    id: serial('id').primaryKey(),
    feed: gardnersFeedEnum('feed').notNull(),
    remotePath: varchar('remote_path', { length: 1000 }).notNull(),
    remoteFilename: varchar('remote_filename', { length: 500 }).notNull(),
    remoteModifiedAt: timestamp('remote_modified_at', { withTimezone: true }),
    remoteSize: integer('remote_size'),
    r2Key: varchar('r2_key', { length: 500 }),
    status: gardnersFetchStatusEnum('status').default('downloading').notNull(),
    totalChunks: integer('total_chunks'),
    processedChunks: integer('processed_chunks').default(0),
    rowCount: integer('row_count'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    feedRemotePathIdx: uniqueIndex('uq_gardners_fetch_log_feed_remote_path').on(t.feed, t.remotePath),
    feedStatusIdx: index('idx_gardners_fetch_log_feed_status').on(t.feed, t.status),
  }),
);

export type GardnersFetchLog = typeof gardnersFetchLog.$inferSelect;
export type NewGardnersFetchLog = typeof gardnersFetchLog.$inferInsert;

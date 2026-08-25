/**
 * Ingestion pipeline tables — owned by the server (migrations run here).
 * The onix_ingester service reads/writes these tables but does NOT migrate them.
 */
import {
  pgTable,
  pgEnum,
  serial,
  integer,
  varchar,
  text,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

export const ingestionStatusEnum = pgEnum('ingestion_status', [
  'pending',
  'processing',
  'enqueued',
  'completed',
  'failed',
]);

export const chunkStatusEnum = pgEnum('chunk_status', [
  'pending',
  'processing',
  'completed',
  'failed',
]);

// One record per ONIX file pulled from R2
export const ingestionJobs = pgTable(
  'ingestion_jobs',
  {
    id: serial('id').primaryKey(),
    fileKey: varchar('file_key', { length: 1000 }).notNull(),
    status: ingestionStatusEnum('status').default('pending').notNull(),
    totalChunks: integer('total_chunks'),
    processedChunks: integer('processed_chunks').default(0),
    failedChunks: integer('failed_chunks').default(0),
    totalBooks: integer('total_books'),
    processedBooks: integer('processed_books').default(0),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    fileKeyIdx: index('idx_ingestion_jobs_file_key').on(t.fileKey),
    statusIdx: index('idx_ingestion_jobs_status').on(t.status),
  }),
);

// One record per 500-book chunk within a job
export const ingestionChunks = pgTable(
  'ingestion_chunks',
  {
    id: serial('id').primaryKey(),
    jobId: integer('job_id')
      .notNull()
      .references(() => ingestionJobs.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    status: chunkStatusEnum('status').default('pending').notNull(),
    bookCount: integer('book_count'),
    processedBooks: integer('processed_books').default(0),
    bullJobId: varchar('bull_job_id', { length: 200 }),
    /**
     * R2 key for the JSON file holding this chunk's parsed OnixProduct[].
     * Null once the chunk has been processed and the R2 object deleted.
     *
     * Replaces an earlier `data` jsonb column that held the payload inline.
     * onix_ingester moved these to R2 and shipped the column change as its own
     * SQL file — but migration ownership for these tables moved to the server,
     * so that file never ran on deploy and the ingester spent weeks failing
     * with `column "data_key" does not exist`. It was eventually patched by
     * hand on the database, which left this schema describing a column that no
     * longer exists and omitting the one that does. Any migration generated
     * from the stale definition would have dropped `data_key` and broken
     * ingestion all over again.
     *
     * The ingester writes this column; the server only owns its migration.
     */
    dataKey: varchar('data_key', { length: 500 }),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    jobIdIdx: index('idx_ingestion_chunks_job_id').on(t.jobId),
  }),
);

export type IngestionJob = typeof ingestionJobs.$inferSelect;
export type NewIngestionJob = typeof ingestionJobs.$inferInsert;
export type IngestionChunk = typeof ingestionChunks.$inferSelect;
export type NewIngestionChunk = typeof ingestionChunks.$inferInsert;

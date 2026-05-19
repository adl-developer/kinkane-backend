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
  jsonb,
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
    // Parsed book data stored here temporarily; cleared after chunk is processed.
    // Keeps large payloads out of Redis.
    data: jsonb('data'),
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

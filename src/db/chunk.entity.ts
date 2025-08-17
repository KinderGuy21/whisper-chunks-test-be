export type ChunkStatus =
  | 'UPLOADED'
  | 'ENQUEUED'
  | 'QUEUED_REMOTE'
  | 'IN_PROGRESS'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'RETRYING';

export interface Chunk {
  sessionId: string;
  seq: number;
  s3Key: string;
  startMs: number;
  endMs: number;
  status: ChunkStatus;
  runpodJobId?: string | null;
  attempt: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  transcriptS3Key?: string | null;
  language?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

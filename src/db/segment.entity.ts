export type SegmentStatus = 'PENDING' | 'SUMMARIZING' | 'SUCCEEDED' | 'FAILED';

export interface Segment {
  sessionId: string;
  segmentIndex: number;
  status: SegmentStatus;
  startMs?: number | null;
  endMs?: number | null;
  tokenCount?: number | null;
  summaryS3Key?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

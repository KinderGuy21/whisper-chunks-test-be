export interface Segment {
  sessionId: string;
  segmentIndex: number;
  status: string; // PENDING, SUMMARIZING, SUCCEEDED, FAILED
  startMs?: number | null;
  endMs?: number | null;
  tokenCount?: number | null;
  summaryS3Key?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

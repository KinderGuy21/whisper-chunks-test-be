export type SessionStatus =
  | 'RECORDING'
  | 'TRANSCRIBING'
  | 'FINALIZING'
  | 'COMPLETE'
  | 'ERROR'
  | 'CANCELLED';

export interface Session {
  sessionId: string;
  status: SessionStatus;
  // business identifiers
  therapistId?: number | null;
  patientId?: number | null;
  organizationId?: number | null;
  appointmentId?: number | null;
  // rolling state for dedupe and segmentation
  rollingTokenCount: number;
  nextSegmentIndex: number;
  endRequested: boolean;
  rollingText: string;
  createdAt: Date;
  updatedAt: Date;
}

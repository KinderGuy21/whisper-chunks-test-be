export type SessionStatus =
  | 'TRANSCRIBING'
  | 'FINALIZING'
  | 'COMPLETE'
  | 'ERROR'
  | 'CANCELLED';

export interface Session {
  sessionId: string;
  status: SessionStatus;
  therapistId?: number | null;
  patientId?: number | null;
  organizationId?: number | null;
  appointmentId?: number | null;
  rollingTokenCount: number;
  nextSegmentIndex: number;
  rollingText: string;
  createdAt: Date;
  updatedAt: Date;
}

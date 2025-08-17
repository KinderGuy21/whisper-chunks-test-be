import {
  Column,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
  CreateDateColumn,
} from 'typeorm';

export type SessionStatus =
  | 'RECORDING'
  | 'TRANSCRIBING'
  | 'FINALIZING'
  | 'COMPLETE'
  | 'ERROR'
  | 'CANCELLED';

@Entity('sessions')
export class Session {
  @PrimaryColumn('text')
  sessionId!: string;

  @Column('text', { default: 'RECORDING' })
  status!: SessionStatus;

  // business identifiers
  @Column('bigint', { nullable: true }) therapistId!: number | null;
  @Column('bigint', { nullable: true }) patientId!: number | null;
  @Column('bigint', { nullable: true }) organizationId!: number | null;
  @Column('bigint', { nullable: true }) appointmentId!: number | null;

  // rolling state for dedupe and segmentation
  @Column('double precision', { default: 0 })
  lastKeptEndSeconds!: number;

  @Column('int', { default: 0 })
  rollingTokenCount!: number;

  @Column('int', { default: 0 })
  nextSegmentIndex!: number;

  @Column('bool', { default: false })
  endRequested!: boolean;

  @Column('text', { default: '' })
  rollingText!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

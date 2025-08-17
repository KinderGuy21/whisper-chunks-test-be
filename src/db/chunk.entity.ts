import {
  Column,
  Entity,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

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

@Entity('chunks')
export class Chunk {
  @PrimaryColumn('text')
  sessionId!: string;

  @PrimaryColumn('int')
  seq!: number;

  @Column('text')
  s3Key!: string;

  @Column('bigint')
  startMs!: number;

  @Column('bigint')
  endMs!: number;

  @Column('text', { default: 'UPLOADED' })
  status!: ChunkStatus;

  @Column('text', { nullable: true })
  runpodJobId!: string | null;

  @Column('int', { default: 0 })
  attempt!: number;

  @Column('text', { nullable: true })
  errorCode!: string | null;

  @Column('text', { nullable: true })
  errorMessage!: string | null;

  @Column('text', { nullable: true })
  transcriptS3Key!: string | null;

  @Column('text', { nullable: true })
  language!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

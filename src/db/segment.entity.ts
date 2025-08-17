import {
  Column,
  Entity,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('segments')
export class Segment {
  @PrimaryColumn('text')
  sessionId!: string;

  @PrimaryColumn('int')
  segmentIndex!: number;

  @Column('text', { default: 'PENDING' }) // PENDING, SUMMARIZING, SUCCEEDED, FAILED
  status!: string;

  @Column('bigint', { nullable: true })
  startMs!: number | null;

  @Column('bigint', { nullable: true })
  endMs!: number | null;

  @Column('int', { nullable: true })
  tokenCount!: number | null;

  @Column('text', { nullable: true })
  summaryS3Key!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

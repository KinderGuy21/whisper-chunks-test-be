import { Controller, Get, Param } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Session } from '../db/session.entity';
import { Chunk } from '../db/chunk.entity';
import { Segment } from '../db/segment.entity';

@Controller('sessions')
export class SessionsController {
  constructor(
    @InjectRepository(Session) private sessions: Repository<Session>,
    @InjectRepository(Chunk) private chunks: Repository<Chunk>,
    @InjectRepository(Segment) private segments: Repository<Segment>,
  ) {}

  @Get(':id/progress')
  async progress(@Param('id') id: string) {
    const s = await this.sessions.findOneBy({ sessionId: id });
    const all = await this.chunks.find({ where: { sessionId: id } });
    const done = all.filter((c) => c.status === 'SUCCEEDED').length;
    const failed = all.filter((c) =>
      ['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(c.status),
    ).length;
    const pct = all.length ? Math.round((done / all.length) * 1000) / 10 : 0;
    return { session: s, total: all.length, done, failed, pct };
  }

  @Get(':id/chunks')
  async listChunks(@Param('id') id: string) {
    return this.chunks.find({
      where: { sessionId: id },
      order: { seq: 'ASC' },
    });
  }

  @Get(':id/segments')
  async listSegments(@Param('id') id: string) {
    return this.segments.find({
      where: { sessionId: id },
      order: { segmentIndex: 'ASC' },
    });
  }
}

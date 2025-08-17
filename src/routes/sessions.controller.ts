import { Controller, Get, Param } from '@nestjs/common';
import { Session } from '../db/session.entity';
import { Chunk } from '../db/chunk.entity';
import { Segment } from '../db/segment.entity';
import { RedisService } from '../db/redis.service';

@Controller('sessions')
export class SessionsController {
  constructor(private redis: RedisService) {}

  @Get(':id/progress')
  async progress(@Param('id') id: string) {
    const s = await this.redis.getSession(id);
    const all = await this.redis.getChunksBySession(id);
    const done = all.filter((c) => c.status === 'SUCCEEDED').length;
    const failed = all.filter((c) =>
      ['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(c.status),
    ).length;
    const pct = all.length ? Math.round((done / all.length) * 1000) / 10 : 0;
    return { session: s, total: all.length, done, failed, pct };
  }

  @Get(':id/chunks')
  async listChunks(@Param('id') id: string) {
    return this.redis.getChunksBySession(id);
  }

  @Get(':id/segments')
  async listSegments(@Param('id') id: string) {
    return this.redis.getSegmentsBySession(id);
  }
}

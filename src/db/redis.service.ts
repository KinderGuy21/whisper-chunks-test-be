import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Session, SessionStatus } from './session.entity';
import { Chunk, ChunkStatus } from './chunk.entity';
import { Segment } from './segment.entity';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private redis: Redis;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    this.redis = new Redis({
      host: this.configService.get('REDIS_HOST') || 'localhost',
      port: Number(this.configService.get('REDIS_PORT')) || 6379,
      password: this.configService.get('REDIS_PASSWORD'),
      db: Number(this.configService.get('REDIS_DB')) || 0,
    });

    this.redis.on('connect', () => {
      console.log('✅ Redis connection established successfully');
    });

    this.redis.on('error', (error) => {
      console.error('❌ Redis connection error:', error);
    });
  }

  async onModuleDestroy() {
    if (this.redis) {
      await this.redis.quit();
    }
  }

  // Session operations
  async createSession(
    session: Omit<Session, 'createdAt' | 'updatedAt'>,
  ): Promise<void> {
    const now = new Date();
    const sessionData = {
      ...session,
      createdAt: now,
      updatedAt: now,
    };

    await this.redis.hset(`session:${session.sessionId}`, sessionData);
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const data = await this.redis.hgetall(`session:${sessionId}`);
    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    return {
      sessionId: data.sessionId,
      status: data.status as SessionStatus,
      therapistId: data.therapistId ? Number(data.therapistId) : null,
      patientId: data.patientId ? Number(data.patientId) : null,
      organizationId: data.organizationId ? Number(data.organizationId) : null,
      appointmentId: data.appointmentId ? Number(data.appointmentId) : null,
      rollingTokenCount: Number(data.rollingTokenCount) || 0,
      nextSegmentIndex: Number(data.nextSegmentIndex) || 0,
      nextExpectedSeq: Number(data.nextExpectedSeq) || 0,
      endRequested: data.endRequested === 'true',
      rollingText: data.rollingText || '',
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
    };
  }

  async updateSession(
    sessionId: string,
    updates: Partial<Session>,
  ): Promise<void> {
    const updateData = {
      ...updates,
      updatedAt: new Date(),
    };

    await this.redis.hset(`session:${sessionId}`, updateData);
  }

  // Chunk operations
  async createChunk(
    chunk: Omit<Chunk, 'createdAt' | 'updatedAt'>,
  ): Promise<void> {
    const now = new Date();
    const chunkData = {
      ...chunk,
      createdAt: now,
      updatedAt: now,
    };

    await this.redis.hset(`chunk:${chunk.sessionId}:${chunk.seq}`, chunkData);
  }

  async getChunk(sessionId: string, seq: number): Promise<Chunk | null> {
    const data = await this.redis.hgetall(`chunk:${sessionId}:${seq}`);
    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    return {
      sessionId: data.sessionId,
      seq: Number(data.seq),
      s3Key: data.s3Key,
      startMs: Number(data.startMs),
      endMs: Number(data.endMs),
      status: data.status as ChunkStatus,
      runpodJobId: data.runpodJobId || null,
      attempt: Number(data.attempt) || 0,
      errorCode: data.errorCode || null,
      errorMessage: data.errorMessage || null,
      transcriptS3Key: data.transcriptS3Key || null,
      language: data.language || null,
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
    };
  }

  async updateChunk(
    sessionId: string,
    seq: number,
    updates: Partial<Chunk>,
  ): Promise<void> {
    const updateData = {
      ...updates,
      updatedAt: new Date(),
    };

    await this.redis.hset(`chunk:${sessionId}:${seq}`, updateData);
  }

  async getChunksBySession(sessionId: string): Promise<Chunk[]> {
    const keys = await this.redis.keys(`chunk:${sessionId}:*`);
    const chunks: Chunk[] = [];

    for (const key of keys) {
      const data = await this.redis.hgetall(key);
      if (data && Object.keys(data).length > 0) {
        chunks.push({
          sessionId: data.sessionId,
          seq: Number(data.seq),
          s3Key: data.s3Key,
          startMs: Number(data.startMs),
          endMs: Number(data.endMs),
          status: data.status as ChunkStatus,
          runpodJobId: data.runpodJobId || null,
          attempt: Number(data.attempt) || 0,
          errorCode: data.errorCode || null,
          errorMessage: data.errorMessage || null,
          transcriptS3Key: data.transcriptS3Key || null,
          language: data.language || null,
          createdAt: new Date(data.createdAt),
          updatedAt: new Date(data.updatedAt),
        });
      }
    }

    return chunks.sort((a, b) => a.seq - b.seq);
  }

  // Segment operations
  async createSegment(
    segment: Omit<Segment, 'createdAt' | 'updatedAt'>,
  ): Promise<void> {
    const now = new Date();
    const segmentData = {
      ...segment,
      createdAt: now,
      updatedAt: now,
    };

    await this.redis.hset(
      `segment:${segment.sessionId}:${segment.segmentIndex}`,
      segmentData,
    );
  }

  async getSegment(
    sessionId: string,
    segmentIndex: number,
  ): Promise<Segment | null> {
    const data = await this.redis.hgetall(
      `segment:${sessionId}:${segmentIndex}`,
    );
    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    return {
      sessionId: data.sessionId,
      segmentIndex: Number(data.segmentIndex),
      status: data.status,
      startMs: data.startMs ? Number(data.startMs) : null,
      endMs: data.endMs ? Number(data.endMs) : null,
      tokenCount: data.tokenCount ? Number(data.tokenCount) : null,
      summaryS3Key: data.summaryS3Key || null,
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
    };
  }

  async updateSegment(
    sessionId: string,
    segmentIndex: number,
    updates: Partial<Segment>,
  ): Promise<void> {
    const updateData = {
      ...updates,
      updatedAt: new Date(),
    };

    await this.redis.hset(`segment:${sessionId}:${segmentIndex}`, updateData);
  }

  async getSegmentsBySession(sessionId: string): Promise<Segment[]> {
    const keys = await this.redis.keys(`segment:${sessionId}:*`);
    const segments: Segment[] = [];

    for (const key of keys) {
      const data = await this.redis.hgetall(key);
      if (data && Object.keys(data).length > 0) {
        segments.push({
          sessionId: data.sessionId,
          segmentIndex: Number(data.segmentIndex),
          status: data.status,
          startMs: data.startMs ? Number(data.startMs) : null,
          endMs: data.endMs ? Number(data.endMs) : null,
          tokenCount: data.tokenCount ? Number(data.tokenCount) : null,
          summaryS3Key: data.summaryS3Key || null,
          createdAt: new Date(data.createdAt),
          updatedAt: new Date(data.updatedAt),
        });
      }
    }

    return segments.sort((a, b) => a.segmentIndex - b.segmentIndex);
  }
}

import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Session, SessionStatus } from './session.entity';
import { Chunk, ChunkStatus } from './chunk.entity';
import { Segment, SegmentStatus } from './segment.entity';

function kSession(id: string) {
  return `session:${id}`;
}
function kChunks(id: string) {
  return `session:${id}:chunks`; // HASH: field="{seq}|{field}", value=scalar
}
function kSegments(id: string) {
  return `session:${id}:segments`; // HASH: field="{idx}|{field}", value=scalar
}
function cf(seq: number, field: string) {
  return `${seq}|${field}`;
}
function sf(idx: number, field: string) {
  return `${idx}|${field}`;
}

// Keep one canonical list so HMGET knows exactly which fields to read/write
const CHUNK_FIELDS = [
  'sessionId',
  'seq',
  's3Key',
  'startMs',
  'endMs',
  'status',
  'predictionId',
  'attempt',
  'errorCode',
  'errorMessage',
  'transcriptS3Key',
  'language',
  'createdAt',
  'updatedAt',
] as const;

const SEGMENT_FIELDS = [
  'sessionId',
  'segmentIndex',
  'status',
  'startMs',
  'endMs',
  'tokenCount',
  'summaryS3Key',
  'createdAt',
  'updatedAt',
] as const;

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
    if (this.redis) await this.redis.quit();
  }

  // ----------------- Sessions (unchanged layout) -----------------

  async createSession(
    session: Omit<Session, 'createdAt' | 'updatedAt'>,
  ): Promise<void> {
    const now = new Date().toISOString();
    const data = {
      ...session,
      createdAt: now,
      updatedAt: now,
    } as Record<string, string | number | null>;
    await this.redis.hset(kSession(session.sessionId), data as any);
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const data = await this.redis.hgetall(kSession(sessionId));
    if (!data || Object.keys(data).length === 0) return null;

    return {
      sessionId: data.sessionId,
      status: data.status as SessionStatus,
      therapistId: data.therapistId ? Number(data.therapistId) : null,
      patientId: data.patientId ? Number(data.patientId) : null,
      organizationId: data.organizationId ? Number(data.organizationId) : null,
      appointmentId: data.appointmentId ? Number(data.appointmentId) : null,
      rollingTokenCount: Number(data.rollingTokenCount) || 0,
      nextSegmentIndex: Number(data.nextSegmentIndex) || 0,
      rollingText: data.rollingText || '',
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
    };
  }

  async updateSession(
    sessionId: string,
    updates: Partial<Session>,
  ): Promise<void> {
    const data: Record<string, any> = {
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    await this.redis.hset(kSession(sessionId), data);
  }

  // ----------------- Chunks (collapsed to one HASH per session) -----------------

  async createChunk(
    chunk: Omit<Chunk, 'createdAt' | 'updatedAt'>,
  ): Promise<void> {
    const now = new Date().toISOString();
    const key = kChunks(chunk.sessionId);
    const fields: Record<string, string | number> = {
      [cf(chunk.seq, 'sessionId')]: chunk.sessionId,
      [cf(chunk.seq, 'seq')]: chunk.seq,
      [cf(chunk.seq, 's3Key')]: chunk.s3Key,
      [cf(chunk.seq, 'startMs')]: chunk.startMs,
      [cf(chunk.seq, 'endMs')]: chunk.endMs,
      [cf(chunk.seq, 'status')]: chunk.status,
      [cf(chunk.seq, 'predictionId')]: chunk.predictionId ?? '',
      [cf(chunk.seq, 'attempt')]: chunk.attempt ?? 0,
      [cf(chunk.seq, 'errorCode')]: chunk.errorCode ?? '',
      [cf(chunk.seq, 'errorMessage')]: chunk.errorMessage ?? '',
      [cf(chunk.seq, 'transcriptS3Key')]: chunk.transcriptS3Key ?? '',
      [cf(chunk.seq, 'language')]: chunk.language ?? '',
      [cf(chunk.seq, 'createdAt')]: now,
      [cf(chunk.seq, 'updatedAt')]: now,
    };
    await this.redis.hset(key, fields);
  }

  async getChunk(sessionId: string, seq: number): Promise<Chunk | null> {
    const key = kChunks(sessionId);
    const names = CHUNK_FIELDS.map((f) => cf(seq, f));
    const values = await this.redis.hmget(key, ...names);

    // If all are null/empty, chunk does not exist
    if (!values.some((v) => v !== null && v !== undefined && v !== ''))
      return null;

    const m = Object.fromEntries(
      values.map((v, i) => [CHUNK_FIELDS[i], v ?? '']),
    );

    return {
      sessionId,
      seq: Number(m.seq ?? seq),
      s3Key: String(m.s3Key ?? ''),
      startMs: Number(m.startMs ?? 0),
      endMs: Number(m.endMs ?? 0),
      status: (m.status as ChunkStatus) ?? 'UPLOADED',
      predictionId: m.predictionId ? String(m.predictionId) : null,
      attempt: Number(m.attempt ?? 0),
      errorCode: m.errorCode ? String(m.errorCode) : null,
      errorMessage: m.errorMessage ? String(m.errorMessage) : null,
      transcriptS3Key: m.transcriptS3Key ? String(m.transcriptS3Key) : null,
      language: m.language ? String(m.language) : null,
      createdAt: new Date(String(m.createdAt || new Date().toISOString())),
      updatedAt: new Date(String(m.updatedAt || new Date().toISOString())),
    };
  }

  async updateChunk(
    sessionId: string,
    seq: number,
    updates: Partial<Chunk>,
  ): Promise<void> {
    const key = kChunks(sessionId);
    const now = new Date().toISOString();
    const fields: Record<string, string | number> = {
      [cf(seq, 'updatedAt')]: now,
    };

    if (updates.s3Key !== undefined) fields[cf(seq, 's3Key')] = updates.s3Key;
    if (updates.startMs !== undefined)
      fields[cf(seq, 'startMs')] = updates.startMs;
    if (updates.endMs !== undefined) fields[cf(seq, 'endMs')] = updates.endMs;
    if (updates.status !== undefined)
      fields[cf(seq, 'status')] = updates.status;
    if (updates.predictionId !== undefined)
      fields[cf(seq, 'predictionId')] = updates.predictionId ?? '';
    if (updates.attempt !== undefined)
      fields[cf(seq, 'attempt')] = updates.attempt;
    if (updates.errorCode !== undefined)
      fields[cf(seq, 'errorCode')] = updates.errorCode ?? '';
    if (updates.errorMessage !== undefined)
      fields[cf(seq, 'errorMessage')] = updates.errorMessage ?? '';
    if (updates.transcriptS3Key !== undefined)
      fields[cf(seq, 'transcriptS3Key')] = updates.transcriptS3Key ?? '';
    if (updates.language !== undefined)
      fields[cf(seq, 'language')] = updates.language ?? '';

    await this.redis.hset(key, fields);
  }

  async getChunksBySession(sessionId: string): Promise<Chunk[]> {
    const flat = await this.redis.hgetall(kChunks(sessionId));
    if (!flat || Object.keys(flat).length === 0) return [];

    // Group fields by seq
    const bySeq: Record<string, Record<string, string>> = {};
    for (const [k, v] of Object.entries(flat)) {
      const i = k.indexOf('|');
      if (i <= 0) continue;
      const seq = k.slice(0, i);
      const field = k.slice(i + 1);
      (bySeq[seq] ??= {})[field] = v;
    }

    const out: Chunk[] = [];
    for (const [seqStr, m] of Object.entries(bySeq)) {
      const seq = Number(seqStr);
      out.push({
        sessionId,
        seq,
        s3Key: String(m.s3Key ?? ''),
        startMs: Number(m.startMs ?? 0),
        endMs: Number(m.endMs ?? 0),
        status: (m.status as ChunkStatus) ?? 'UPLOADED',
        predictionId: m.predictionId ? String(m.predictionId) : null,
        attempt: Number(m.attempt ?? 0),
        errorCode: m.errorCode ? String(m.errorCode) : null,
        errorMessage: m.errorMessage ? String(m.errorMessage) : null,
        transcriptS3Key: m.transcriptS3Key ? String(m.transcriptS3Key) : null,
        language: m.language ? String(m.language) : null,
        createdAt: new Date(String(m.createdAt || new Date().toISOString())),
        updatedAt: new Date(String(m.updatedAt || new Date().toISOString())),
      });
    }

    return out.sort((a, b) => a.seq - b.seq);
  }

  // ----------------- Segments (collapsed to one HASH per session) -----------------

  async createSegment(
    segment: Omit<Segment, 'createdAt' | 'updatedAt'>,
  ): Promise<void> {
    const now = new Date().toISOString();
    const key = kSegments(segment.sessionId);
    const idx = segment.segmentIndex;

    const fields: Record<string, string | number> = {
      [sf(idx, 'sessionId')]: segment.sessionId,
      [sf(idx, 'segmentIndex')]: idx,
      [sf(idx, 'status')]: segment.status,
      [sf(idx, 'startMs')]: segment.startMs ?? '',
      [sf(idx, 'endMs')]: segment.endMs ?? '',
      [sf(idx, 'tokenCount')]: segment.tokenCount ?? '',
      [sf(idx, 'summaryS3Key')]: segment.summaryS3Key ?? '',
      [sf(idx, 'createdAt')]: now,
      [sf(idx, 'updatedAt')]: now,
    };
    await this.redis.hset(key, fields);
  }

  async getSegment(
    sessionId: string,
    segmentIndex: number,
  ): Promise<Segment | null> {
    const key = kSegments(sessionId);
    const names = SEGMENT_FIELDS.map((f) => sf(segmentIndex, f));
    const values = await this.redis.hmget(key, ...names);

    if (!values.some((v) => v !== null && v !== undefined && v !== ''))
      return null;

    const m = Object.fromEntries(
      values.map((v, i) => [SEGMENT_FIELDS[i], v ?? '']),
    );

    return {
      sessionId,
      segmentIndex: Number(m.segmentIndex ?? segmentIndex),
      status: (m.status as SegmentStatus) ?? 'PENDING',
      startMs: m.startMs ? Number(m.startMs) : null,
      endMs: m.endMs ? Number(m.endMs) : null,
      tokenCount: m.tokenCount ? Number(m.tokenCount) : null,
      summaryS3Key: m.summaryS3Key ? String(m.summaryS3Key) : null,
      createdAt: new Date(String(m.createdAt || new Date().toISOString())),
      updatedAt: new Date(String(m.updatedAt || new Date().toISOString())),
    };
  }

  async updateSegment(
    sessionId: string,
    segmentIndex: number,
    updates: Partial<Segment>,
  ): Promise<void> {
    const key = kSegments(sessionId);
    const now = new Date().toISOString();
    const fields: Record<string, string | number> = {
      [sf(segmentIndex, 'updatedAt')]: now,
    };

    if (updates.status !== undefined)
      fields[sf(segmentIndex, 'status')] = updates.status;
    if (updates.startMs !== undefined)
      fields[sf(segmentIndex, 'startMs')] = updates.startMs ?? '';
    if (updates.endMs !== undefined)
      fields[sf(segmentIndex, 'endMs')] = updates.endMs ?? '';
    if (updates.tokenCount !== undefined)
      fields[sf(segmentIndex, 'tokenCount')] = updates.tokenCount ?? '';
    if (updates.summaryS3Key !== undefined)
      fields[sf(segmentIndex, 'summaryS3Key')] = updates.summaryS3Key ?? '';

    await this.redis.hset(key, fields);
  }

  async getSegmentsBySession(sessionId: string): Promise<Segment[]> {
    const flat = await this.redis.hgetall(kSegments(sessionId));
    if (!flat || Object.keys(flat).length === 0) return [];

    // Group fields by segmentIndex
    const byIdx: Record<string, Record<string, string>> = {};
    for (const [k, v] of Object.entries(flat)) {
      const i = k.indexOf('|');
      if (i <= 0) continue;
      const idx = k.slice(0, i);
      const field = k.slice(i + 1);
      (byIdx[idx] ??= {})[field] = v;
    }

    const out: Segment[] = [];
    for (const [idxStr, m] of Object.entries(byIdx)) {
      const idx = Number(idxStr);
      out.push({
        sessionId,
        segmentIndex: idx,
        status: (m.status as SegmentStatus) ?? 'PENDING',
        startMs: m.startMs ? Number(m.startMs) : null,
        endMs: m.endMs ? Number(m.endMs) : null,
        tokenCount: m.tokenCount ? Number(m.tokenCount) : null,
        summaryS3Key: m.summaryS3Key ? String(m.summaryS3Key) : null,
        createdAt: new Date(String(m.createdAt || new Date().toISOString())),
        updatedAt: new Date(String(m.updatedAt || new Date().toISOString())),
      });
    }

    return out.sort((a, b) => a.segmentIndex - b.segmentIndex);
  }
}

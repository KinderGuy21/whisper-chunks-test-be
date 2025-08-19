import { Injectable } from '@nestjs/common';
import { Session } from '../db/session.entity';
import { Chunk } from '../db/chunk.entity';
import { Segment } from '../db/segment.entity';
import { S3Service } from '../s3/s3.service';
import { ConfigService } from '@nestjs/config';
import { SummarizerService } from '../summary/summarizer.service';
import { RedisService } from '../db/redis.service';

type FWWord = {
  word: string;
  start?: number;
  end?: number;
};
type FWSegment = { text: string; start: number; end: number; words?: FWWord[] };
type FWOutput = {
  segments: FWSegment[];
  language?: string;
  word_timestamps?: FWWord[];
};

const STRIP_BIDI = /[\u200E\u200F\u202A-\u202E]/g;
function cleanupWord(s: string) {
  // remove bidi/invisible direction chars; keep spacing as-is
  return (s ?? '').replace(STRIP_BIDI, '');
}
@Injectable()
export class StateService {
  private tokenThreshold: number;

  constructor(
    private redis: RedisService,
    private s3: S3Service,
    cfg: ConfigService,
    private summarizer: SummarizerService,
  ) {
    console.log('🏗️  Initializing StateService...');
    this.tokenThreshold = Number(cfg.get('ROLLING_THRESHOLD_TOKENS') ?? 1200);
    console.log(`   - Token Threshold: ${this.tokenThreshold}`);
    console.log('✅ StateService initialized');
  }

  async setChunkStatus(
    sessionId: string,
    seq: number,
    status: Chunk['status'],
    extra: Partial<Chunk> = {},
  ) {
    console.log(
      `🔄 Setting chunk status: session ${sessionId}, seq ${seq} -> ${status}`,
    );

    const startTime = Date.now();

    try {
      await this.redis.updateChunk(sessionId, seq, { status, ...extra });
      const duration = Date.now() - startTime;
      console.log(`✅ Chunk status updated successfully in ${duration}ms`);
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(
        `❌ Failed to update chunk status after ${duration}ms:`,
        error,
      );
      throw error;
    }
  }

  private estimateTokens(text: string) {
    // simple heuristic for POC
    const tokens = Math.ceil(text.length / 4);
    console.log(
      `🔢 Token estimation: "${text.substring(0, 10)}..." -> ${tokens} tokens`,
    );
    return tokens;
  }

  private flattenWords(output: FWOutput, offsetSeconds = 0): FWWord[] {
    const out: FWWord[] = [];

    // Prefer top-level word_timestamps if present
    const wt = output?.word_timestamps;
    if (Array.isArray(wt) && wt.length) {
      for (const w of wt) {
        const start = Number(w.start ?? 0) + offsetSeconds;
        const end = Number(w.end ?? w.start ?? 0) + offsetSeconds;
        out.push({
          word: cleanupWord(String(w.word ?? '')) + ' ', // keep a trailing space to simplify joining
          start,
          end,
        });
      }
      // Ensure monotonic order just in case
      out.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
      return out;
    }

    // Fallback: pull words from segments[] if they exist, else make a single "word" per segment
    const segs = output.segments || [];
    for (const s of segs) {
      const startBase = (s?.start ?? 0) + offsetSeconds;
      const endBase = (s?.end ?? s?.start ?? 0) + offsetSeconds;

      if (Array.isArray(s.words) && s.words.length) {
        for (const w of s.words) {
          out.push({
            word: cleanupWord(String(w.word ?? '')) + ' ',
            start: (w.start ?? startBase) + offsetSeconds,
            end: (w.end ?? w.start ?? startBase) + offsetSeconds,
          });
        }
      } else {
        // No word-level timing: treat the whole segment as a single token
        out.push({
          word: cleanupWord(String(s.text ?? '')) + ' ',
          start: startBase,
          end: endBase,
        });
      }
    }

    out.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    return out;
  }

  private cleanJoin(words: FWWord[]) {
    // words often include leading spaces, join then normalize
    const joined = words.map((w) => w.word).join('');
    const cleaned = joined.replace(/\s+/g, ' ').trim();
    console.log(
      `🧹 Cleaned text: "${joined.substring(0, 10)}..." -> "${cleaned.substring(0, 10)}..."`,
    );
    return cleaned;
  }

  async handleSuccess(
    sessionId: string,
    seq: number,
    output: FWOutput,
    startMs: number,
  ) {
    console.log(`🎉 Handling success for session ${sessionId}, seq ${seq}`);

    const startTime = Date.now();

    try {
      // Idempotency guard: if this chunk already succeeded, skip
      const existing = await this.redis.getChunk(sessionId, seq);
      if (existing?.status === 'SUCCEEDED' && existing.transcriptS3Key) {
        console.log(
          `🛑 Duplicate success callback for session ${sessionId}, seq ${seq} - ignoring`,
        );
        return;
      }

      const transcriptKey = `sessions/${sessionId}/transcripts/chunk-${seq}.json`;
      console.log(`📤 Saving transcript to S3: ${transcriptKey}`);

      await this.s3.putObject(
        transcriptKey,
        Buffer.from(JSON.stringify(output)),
        'application/json',
      );
      console.log('✅ Transcript saved to S3 successfully');

      // mark chunk
      console.log('💾 Updating chunk status to SUCCEEDED...');
      await this.redis.updateChunk(sessionId, seq, {
        status: 'SUCCEEDED',
        transcriptS3Key: transcriptKey,
        language: output.language || null,
      });
      console.log('✅ Chunk status updated to SUCCEEDED');

      // merge and maybe summarize
      console.log('🔄 Merging transcript and checking for summarization...');
      await this.mergeAndMaybeSummarize(sessionId, output);

      const totalTime = Date.now() - startTime;
      console.log(`🎉 Success handling completed in ${totalTime}ms`);
    } catch (error) {
      const totalTime = Date.now() - startTime;
      console.error(`❌ Success handling failed after ${totalTime}ms:`, error);
      throw error;
    }
  }

  private async mergeAndMaybeSummarize(sessionId: string, output: FWOutput) {
    // 1) Precompute merge outside the transaction
    const words = this.flattenWords(output);
    const text = this.cleanJoin(words);

    // 2) Get or create session
    let session = await this.redis.getSession(sessionId);
    if (!session) {
      await this.redis.createSession({
        sessionId,
        status: 'TRANSCRIBING',
        therapistId: null,
        patientId: null,
        organizationId: null,
        appointmentId: null,
        rollingTokenCount: 0,
        nextSegmentIndex: 0,
        endRequested: false,
        rollingText: '',
      });
      session = await this.redis.getSession(sessionId);
    }

    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const tokens = this.estimateTokens(text);
    const combinedText = session.rollingText
      ? `${session.rollingText} ${text}`
      : text;
    const newTokenCount = session.rollingTokenCount + tokens;

    // Decide whether to cut a segment
    const threshold = this.tokenThreshold;
    const shouldSummarize =
      combinedText.trim().length > 0 && newTokenCount >= threshold;
    console.log('📝 Should summarize?', shouldSummarize);
    console.log('TOTAL STORED TEXT:', combinedText);
    console.log('previous REDIS session:', session);
    if (!shouldSummarize) {
      console.log('📝 Not summarizing..., not enough text');
      await this.redis.updateSession(sessionId, {
        rollingText: combinedText,
        rollingTokenCount: newTokenCount,
      });
      return;
    }
    console.log('📝 Summarizing!...');
    // We will close the rolling buffer into a segment
    const idx = session.nextSegmentIndex;
    const segInputKey = `sessions/${sessionId}/segments/segment-${idx}-input.txt`;

    // Insert a new segment row (PENDING); summary key will be filled later by the summarizer
    await this.redis.createSegment({
      sessionId,
      segmentIndex: idx,
      status: 'PENDING',
      tokenCount: newTokenCount,
    });

    // Reset rolling state and advance segment index
    await this.redis.updateSession(sessionId, {
      nextSegmentIndex: idx + 1,
      rollingTokenCount: 0,
      rollingText: '',
    });

    // 3) Post-commit I/O (no DB locks held)
    await this.s3.putObject(
      segInputKey,
      Buffer.from(combinedText.trim()),
      'text/plain',
    );
    await this.summarizer.invokeChunkSummarizer(sessionId, idx, segInputKey);
  }
}

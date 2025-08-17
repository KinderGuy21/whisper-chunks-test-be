import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Session } from '../db/session.entity';
import { Chunk } from '../db/chunk.entity';
import { Segment } from '../db/segment.entity';
import { S3Service } from '../s3/s3.service';
import { ConfigService } from '@nestjs/config';
import { SummarizerService } from '../summary/summarizer.service';

type FWWord = {
  word: string;
  start?: number;
  end?: number;
  probability?: number;
};
type FWSegment = { text: string; start: number; end: number; words?: FWWord[] };
type FWOutput = { segments: FWSegment[]; language?: string };

@Injectable()
export class StateService {
  private tokenThreshold: number;

  constructor(
    @InjectRepository(Session) private sessions: Repository<Session>,
    @InjectRepository(Chunk) private chunks: Repository<Chunk>,
    @InjectRepository(Segment) private segments: Repository<Segment>,
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
    console.log(`   - Extra fields:`, extra);

    const startTime = Date.now();

    try {
      await this.chunks.update({ sessionId, seq }, { status, ...extra });
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
      `🔢 Token estimation: "${text.substring(0, 50)}..." -> ${tokens} tokens`,
    );
    return tokens;
  }

  private flattenWords(output: FWOutput): FWWord[] {
    console.log(
      `📝 Flattening words from ${output.segments?.length || 0} segments`,
    );
    const out: FWWord[] = [];
    for (const s of output.segments || []) {
      if (s.words && s.words.length) {
        console.log(
          `   - Segment "${s.text.substring(0, 30)}..." has ${s.words.length} words`,
        );
        out.push(...s.words);
      } else {
        console.log(
          `   - Segment "${s.text.substring(0, 30)}..." has no word-level timing`,
        );
        out.push({ word: s.text + ' ', start: s.start, end: s.end });
      }
    }
    console.log(`✅ Flattened ${out.length} total words`);
    return out;
  }

  private cleanJoin(words: FWWord[]) {
    // words often include leading spaces, join then normalize
    const joined = words.map((w) => w.word).join('');
    const cleaned = joined.replace(/\s+/g, ' ').trim();
    console.log(
      `🧹 Cleaned text: "${joined.substring(0, 100)}..." -> "${cleaned.substring(0, 100)}..."`,
    );
    return cleaned;
  }

  async handleSuccess(sessionId: string, seq: number, output: FWOutput) {
    console.log(`🎉 Handling success for session ${sessionId}, seq ${seq}`);
    console.log(`   - Language: ${output.language || 'unknown'}`);
    console.log(`   - Segments: ${output.segments?.length || 0}`);

    const startTime = Date.now();

    try {
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
      await this.chunks.update(
        { sessionId, seq },
        {
          status: 'SUCCEEDED',
          transcriptS3Key: transcriptKey,
          language: output.language || null,
        },
      );
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
    const epsilon = 0.15;
    const words = this.flattenWords(output);
    const kept: FWWord[] = words; // keep all for now; watermark applied after we read session's lastKeptEndSeconds
    const textAll = this.cleanJoin(kept);
    const tokensAll = this.estimateTokens(textAll);
    const maxEndInChunk = Math.max(0, ...kept.map((w) => w.end || 0));

    // 2) Do the state mutation in a short transaction with a row lock
    type TxResult =
      | { createdSegment: false }
      | {
          createdSegment: true;
          segInputKey: string;
          segmentIndex: number;
          combinedText: string;
        };

    const txResult = await this.sessions.manager.transaction(
      'READ COMMITTED',
      async (em): Promise<TxResult> => {
        const sRepo = em.getRepository(Session);
        const segRepo = em.getRepository(Segment);

        // Make sure session exists (idempotent)
        await sRepo
          .createQueryBuilder()
          .insert()
          .into(Session)
          .values({ sessionId, status: 'TRANSCRIBING' })
          .orIgnore()
          .execute();

        // Lock the session row for update
        const session = await sRepo
          .createQueryBuilder('s')
          .setLock('pessimistic_write')
          .where('s.sessionId = :sessionId', { sessionId })
          .getOne();

        if (!session) {
          // Extremely unlikely due to insert-or-ignore above, but guard anyway
          throw new Error(`Session ${sessionId} not found`);
        }

        // Apply watermark (dedupe) now that we have lastKeptEndSeconds
        const keptAfterWatermark: FWWord[] = [];
        for (const w of kept) {
          const end = w.end ?? 0;
          if (end > session.lastKeptEndSeconds - epsilon)
            keptAfterWatermark.push(w);
        }
        const text = this.cleanJoin(keptAfterWatermark);
        const tokens = this.estimateTokens(text);
        const newEnd = Math.max(session.lastKeptEndSeconds, maxEndInChunk);
        const combinedText =
          (session.rollingText || '') + (text ? ' ' + text : '');
        const newTokenCount = session.rollingTokenCount + tokens;

        // Decide whether to cut a segment
        const threshold = this.tokenThreshold;
        const shouldSummarize =
          combinedText.trim().length > 0 && newTokenCount >= threshold;

        if (!shouldSummarize) {
          await sRepo.update(
            { sessionId },
            {
              rollingText: combinedText,
              rollingTokenCount: newTokenCount,
              lastKeptEndSeconds: newEnd,
            },
          );
          return { createdSegment: false };
        }

        // We will close the rolling buffer into a segment
        const idx = session.nextSegmentIndex;
        const segInputKey = `sessions/${sessionId}/segments/segment-${idx}-input.txt`;

        // Insert a new segment row (PENDING); summary key will be filled later by the summarizer
        await segRepo.insert({
          sessionId,
          segmentIndex: idx,
          status: 'PENDING',
          tokenCount: newTokenCount,
        });

        // Reset rolling state and advance segment index
        await sRepo.update(
          { sessionId },
          {
            nextSegmentIndex: idx + 1,
            rollingTokenCount: 0,
            rollingText: '', // we will persist combinedText to S3 and summarize it
            lastKeptEndSeconds: newEnd,
          },
        );

        // Return what we need to do AFTER commit
        return {
          createdSegment: true,
          segInputKey,
          segmentIndex: idx,
          combinedText: combinedText.trim(),
        };
      },
    );

    // 3) Post-commit I/O (no DB locks held)
    if (txResult.createdSegment) {
      const { segInputKey, segmentIndex, combinedText } = txResult;
      await this.s3.putObject(
        segInputKey,
        Buffer.from(combinedText),
        'text/plain',
      );
      await this.summarizer.invokeChunkSummarizer(
        sessionId,
        segmentIndex,
        segInputKey,
      );
    }
  }
}

import { Body, Controller, Post } from '@nestjs/common';
import { Session } from '../db/session.entity';
import { S3Service } from '../s3/s3.service';
import { SummarizerService } from '../summary/summarizer.service';
import { RedisService } from '../db/redis.service';

@Controller()
export class FinalizeController {
  constructor(
    private redis: RedisService,
    private s3: S3Service,
    private summarizer: SummarizerService,
  ) {
    console.log('🏁 FinalizeController initialized');
  }

  @Post('finalize')
  async finalize(
    @Body('sessionId') sessionId: string,
    @Body('therapistId') therapistIdStr?: string,
    @Body('patientId') patientIdStr?: string,
    @Body('organizationId') organizationIdStr?: string,
    @Body('appointmentId') appointmentIdStr?: string,
  ) {
    // set metadata if provided late
    const patch: Partial<Session> = {
      endRequested: true,
      status: 'FINALIZING',
    };
    if (therapistIdStr) patch.therapistId = Number(therapistIdStr);
    if (patientIdStr) patch.patientId = Number(patientIdStr);
    if (organizationIdStr) patch.organizationId = Number(organizationIdStr);
    if (appointmentIdStr) patch.appointmentId = Number(appointmentIdStr);
    await this.redis.updateSession(sessionId, patch);

    // flush leftover rolling text as a final segment
    const s = await this.redis.getSession(sessionId);
    console.log('FINALIZED SESSION', s);
    if (s && s.rollingText.trim()) {
      const idx = s.nextSegmentIndex;
      const segInputKey = `sessions/${sessionId}/segments/segment-${idx}-input.txt`;
      await this.s3.putObject(
        segInputKey,
        Buffer.from(s.rollingText.trim()),
        'text/plain',
      );
      await this.redis.createSegment({
        sessionId,
        segmentIndex: idx,
        status: 'PENDING',
      });
      await this.summarizer.invokeChunkSummarizer(sessionId, idx, segInputKey);
      await this.redis.updateSession(sessionId, {
        nextSegmentIndex: idx + 1,
        rollingText: '',
        rollingTokenCount: 0,
      });
    }

    // combine summaries
    const all = await this.redis.getSegmentsBySession(sessionId);
    const keys: string[] = all
      .filter((x) => x.summaryS3Key)
      .map((x) => x.summaryS3Key!);
    const consolidatedKey = await this.summarizer.combineSegments(
      sessionId,
      keys,
    );

    // Call the finalizer lambda with the consolidated summary
    console.log('🚀 Calling finalizer lambda...');
    const finalizerResult = await this.summarizer.invokeFinalizerLambda(
      sessionId,
      consolidatedKey,
    );

    await this.redis.updateSession(sessionId, { status: 'COMPLETE' });
    return {
      ok: true,
      consolidatedKey,
      finalizerResult,
    };
  }
}

import { Body, Controller, Post, Query } from '@nestjs/common';
import { StateService } from '../state/state.service';
import { Public } from 'src/decorators/public.decorator';

@Public()
@Controller()
export class CallbackController {
  constructor(private state: StateService) {
    console.log('📞 CallbackController initialized');
  }

  @Post('runpod-callback')
  async runpodCallback(
    @Query('sessionId') sessionId: string,
    @Query('seq') seqStr: string,
    @Query('startMs') _startMs: string,
    @Query('endMs') _endMs: string,
    @Query('bucket') _bucket: string,
    @Query('key') _key: string,
    @Body() body: any,
  ) {
    console.log('📞 RunPod callback received');
    console.log(`   - Session ID: ${sessionId}`);
    console.log(`   - Sequence: ${seqStr}`);
    console.log(`   - Start Time: ${_startMs}ms`);
    console.log(`   - End Time: ${_endMs}ms`);
    console.log(`   - Bucket: ${_bucket}`);
    console.log(`   - Key: ${_key}`);
    console.log(`   - Body:`, body);

    const startTime = Date.now();
    const seq = Number(seqStr);
    const status = (body?.status || '').toUpperCase();

    console.log(`🔍 Processing status: ${status} (original: ${body?.status})`);

    try {
      if (status === 'IN_QUEUE') {
        console.log(
          `⏳ Setting chunk status to QUEUED_REMOTE for session ${sessionId}, seq ${seq}`,
        );
        await this.state.setChunkStatus(sessionId, seq, 'QUEUED_REMOTE');
        console.log('✅ Status updated to QUEUED_REMOTE');
        return { ok: true };
      }

      if (status === 'IN_PROGRESS') {
        console.log(
          `🔄 Setting chunk status to IN_PROGRESS for session ${sessionId}, seq ${seq}`,
        );
        await this.state.setChunkStatus(sessionId, seq, 'IN_PROGRESS');
        console.log('✅ Status updated to IN_PROGRESS');
        return { ok: true };
      }

      if (status === 'FAILED' || status === 'CANCELLED') {
        console.log(
          `❌ Setting chunk status to ${status} for session ${sessionId}, seq ${seq}`,
        );
        console.log(`   - Error Code: ${body?.errorCode || 'N/A'}`);
        console.log(`   - Error Message: ${body?.errorMessage || 'N/A'}`);

        await this.state.setChunkStatus(sessionId, seq, status as any, {
          errorCode: body?.errorCode || null,
          errorMessage: body?.errorMessage || null,
        });
        console.log(`✅ Status updated to ${status}`);
        // optional: schedule retry here
        return { ok: true };
      }

      if (status === 'SUCCEEDED' || status === 'COMPLETED') {
        console.log(body);
        console.log(`🎉 Handling success for session ${sessionId}, seq ${seq}`);
        console.log(`   - Output:`, body.output || body);

        await this.state.handleSuccess(sessionId, seq, body.output || body);
        console.log('✅ Success handled successfully');
        return { ok: true };
      }

      // ignore unknown statuses idempotently
      console.log(`⚠️  Unknown status "${status}" - ignoring`);
      return { ok: true, ignored: true };
    } catch (error) {
      const totalTime = Date.now() - startTime;
      console.error(
        `❌ Callback processing failed after ${totalTime}ms:`,
        error,
      );
      throw error;
    }
  }
}

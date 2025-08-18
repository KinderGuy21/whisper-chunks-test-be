import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
  Body,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { S3Service } from '../s3/s3.service';
import { RabbitService } from '../mq/rabbit.service';
import { RedisService } from '../db/redis.service';

@Controller()
export class UploadController {
  constructor(
    private s3: S3Service,
    private rabbit: RabbitService,
    private redis: RedisService,
  ) {
    console.log('📤 UploadController initialized');
  }

  @Post('upload-chunk')
  @UseInterceptors(FileInterceptor('file'))
  async uploadChunk(
    @UploadedFile() file: Express.Multer.File,
    @Body('sessionId') sessionId: string,
    @Body('seq') seqStr: string,
    @Body('startMs') startMsStr: string,
    @Body('endMs') endMsStr: string,
    // optional metadata
    @Body('therapistId') therapistIdStr?: string,
    @Body('patientId') patientIdStr?: string,
    @Body('organizationId') organizationIdStr?: string,
    @Body('appointmentId') appointmentIdStr?: string,
  ) {
    if (!file) throw new BadRequestException('file is required');
    if (!sessionId) throw new BadRequestException('sessionId is required');

    const seq = Number(seqStr);
    const startMs = Number(startMsStr);
    const endMs = Number(endMsStr);

    const mimeType = file.mimetype || 'application/octet-stream';
    const ext = mimeType.includes('webm')
      ? 'webm'
      : mimeType.includes('mp4')
        ? 'mp4'
        : 'bin'; // fallback

    if (![seq, startMs, endMs].every(Number.isFinite)) {
      throw new BadRequestException('seq, startMs, endMs must be numbers');
    }

    const key = `sessions/${sessionId}/raw/chunk-${seq}-${startMs}-${endMs}.${ext}`;
    await this.s3.putObject(key, file.buffer, mimeType);

    const therapistId = therapistIdStr ? Number(therapistIdStr) : null;
    const patientId = patientIdStr ? Number(patientIdStr) : null;
    const organizationId = organizationIdStr ? Number(organizationIdStr) : null;
    const appointmentId = appointmentIdStr ? Number(appointmentIdStr) : null;

    // upsert session and persist metadata if provided
    const existingSession = await this.redis.getSession(sessionId);
    if (!existingSession) {
      await this.redis.createSession({
        sessionId,
        status: 'TRANSCRIBING',
        therapistId,
        patientId,
        organizationId,
        appointmentId,
        rollingTokenCount: 0,
        nextSegmentIndex: 0,
        endRequested: false,
        rollingText: '',
      });
    } else if (therapistId || patientId || organizationId || appointmentId) {
      await this.redis.updateSession(sessionId, {
        therapistId,
        patientId,
        organizationId,
        appointmentId,
      });
    }

    await this.redis.createChunk({
      sessionId,
      seq,
      s3Key: key,
      startMs,
      endMs,
      status: 'UPLOADED',
      attempt: 0,
    });

    await this.rabbit.publish({
      bucket: this.s3.bucketName(),
      key,
      sessionId,
      seq,
      startMs,
      endMs,
    });

    await this.redis.updateChunk(sessionId, seq, { status: 'ENQUEUED' });
    return { ok: true, key };
  }
}

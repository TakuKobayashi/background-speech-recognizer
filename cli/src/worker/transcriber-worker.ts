import { parentPort, workerData } from 'worker_threads';
import { Transcriber } from '../transcriber';
import { writeWav } from '../utils';
import { makeTmpPath, safeUnlink } from '../platform';

/**
 * Whisper 推論専用の Worker スレッド本体
 *
 * メインスレッドからは PCM Buffer (Transferable) を MessagePort 経由で受け取り、
 * whisper.cpp サブプロセスを起動して文字起こしを行う。完了したら文字列とメタを返す。
 * メインのイベントループ (録音 / VAD) を一切ブロックしない。
 */

interface InitData {
  whisperBin: string;
  modelPath:  string;
  language?:  string;
  threads?:   number;
  timeoutMs?: number;
}

interface JobRequest {
  type: 'job';
  jobId: string;
  pcmBuffer: ArrayBuffer;       // Transferable
  savedWavPath?: string;        // 結果と紐付け用 (Worker は使わない)
  segmentIndex: number;
  startedAtIso: string;
}

interface ShutdownRequest {
  type: 'shutdown';
}

type IncomingMessage = JobRequest | ShutdownRequest;

interface JobResponse {
  type: 'result';
  jobId: string;
  ok:    boolean;
  text?: string;
  durationMs?: number;
  error?: string;
  savedWavPath?: string;
  segmentIndex: number;
  startedAtIso: string;
}

if (!parentPort) {
  throw new Error('transcriber-worker must run as a worker thread');
}

const init = workerData as InitData;
const transcriber = new Transcriber({
  whisperBin: init.whisperBin,
  modelPath:  init.modelPath,
  ...(init.language ? { language: init.language } : {}),
  ...(init.threads  ? { threads:  init.threads  } : {}),
  ...(init.timeoutMs ? { timeoutMs: init.timeoutMs } : {}),
});

parentPort.on('message', (msg: IncomingMessage) => {
  if (msg.type === 'shutdown') {
    process.exit(0);
  }

  if (msg.type === 'job') {
    void handleJob(msg);
  }
});

async function handleJob(msg: JobRequest): Promise<void> {
  const pcm = Buffer.from(msg.pcmBuffer);
  const tmpWav = makeTmpPath('worker', 'wav');

  try {
    writeWav(tmpWav, pcm);
    const result = await transcriber.transcribeFile(tmpWav);
    const res: JobResponse = {
      type: 'result',
      jobId: msg.jobId,
      ok: true,
      text: result.text,
      durationMs: result.durationMs,
      savedWavPath: msg.savedWavPath ?? tmpWav,
      segmentIndex: msg.segmentIndex,
      startedAtIso: msg.startedAtIso,
    };
    parentPort!.postMessage(res);
  } catch (err) {
    const res: JobResponse = {
      type: 'result',
      jobId: msg.jobId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      savedWavPath: msg.savedWavPath ?? tmpWav,
      segmentIndex: msg.segmentIndex,
      startedAtIso: msg.startedAtIso,
    };
    parentPort!.postMessage(res);
  } finally {
    safeUnlink(tmpWav);
  }
}

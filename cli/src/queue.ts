import { RecordingSession } from './recorder';

export interface QueuedSession {
  session: RecordingSession;
  enqueuedAt: Date;
  /** キュー待ち時間 (ms) */
  waitMs(): number;
}

/**
 * 有界セッションキュー
 *
 * 文字起こし処理が遅延している間もセッションを最大 maxSize 件保持する。
 * 上限超過時は最古のセッションを自動ドロップしてメモリを保護する。
 */
export class SessionQueue {
  private items: QueuedSession[] = [];

  constructor(private readonly maxSize = 5) {}

  /**
   * セッションをエンキュー
   * @returns accepted: 常に true / dropped: 上限超過時にドロップされたセッション
   */
  enqueue(session: RecordingSession): { accepted: boolean; dropped: QueuedSession | null } {
    let dropped: QueuedSession | null = null;

    if (this.items.length >= this.maxSize) {
      dropped = this.items.shift()!;
    }

    const enqueuedAt = new Date();
    this.items.push({
      session,
      enqueuedAt,
      waitMs: () => Date.now() - enqueuedAt.getTime(),
    });

    return { accepted: true, dropped };
  }

  dequeue(): QueuedSession | undefined {
    return this.items.shift();
  }

  get size(): number  { return this.items.length; }
  get isEmpty(): boolean { return this.items.length === 0; }

  /** キュー内の全バッファを解放してメモリを返す */
  clear(): void {
    // Buffer の参照を明示的に切って GC を促す
    for (const item of this.items) {
      (item.session as { pcmBuffer?: Buffer }).pcmBuffer = undefined as unknown as Buffer;
    }
    this.items = [];
  }
}

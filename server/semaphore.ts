// 동시 실행 제어 — Claude API 스트림 수 제한 (대기열 + 포화 시 즉시 429 판단)
export class Semaphore {
  private active  = 0
  private queue: Array<() => void> = []

  constructor(private max: number) {}

  acquire(): Promise<void> {
    return new Promise(resolve => {
      if (this.active < this.max) { this.active++; resolve() }
      else this.queue.push(resolve)
    })
  }

  release(): void {
    const next = this.queue.shift()
    if (next) next()
    else this.active--
  }

  get size()    { return this.active }
  get pending() { return this.queue.length }

  // 활성 + 대기가 모두 꽉 찬 경우 (즉시 거절 기준)
  isOverloaded(): boolean {
    return this.active >= this.max && this.queue.length >= this.max * 2
  }
}

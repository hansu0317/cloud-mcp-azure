// 동시 실행 제어 — CLI 모드(Claude Code 프로세스)와 API 모드(Claude API 스트림)가
// 공용으로 쓰는 단일 구현. 운영자가 두 모드에 서로 다른 동시성 정책을 배울 필요가 없다.
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

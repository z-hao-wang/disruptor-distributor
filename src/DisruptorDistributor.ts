// https://github.com/davedoesdev/shared-memory-disruptor
// https://rawgit-now.davedoesdev.now.sh/davedoesdev/shared-memory-disruptor/master/docs/index.html
// type definition for disruptor class
declare class DisruptorClass {
  constructor(
    shm_name: string,
    num_elements: number,
    element_size: number,
    num_consumers: number,
    consumer: number,
    init: boolean,
    spin: boolean,
  );
  consumeNew(): Promise<{ bufs: Buffer[] }>;
  consumeCommit(): Promise<boolean>;
}
const { Disruptor } = require('shared-memory-disruptor');

export namespace DisruptorDistributor {
  export interface DisruptorConfig {
    queueName: string;
    // how many num elements in Disruptor cache, capacity
    numElements: number; // Total number of objects that will be reading data from the Disruptor.
    consumersCount: number;
    consumerIndex: number;
    elementSize: number; // Size of each element in bytes.
    dataLen: number;
    sequenceBytes: number; // the sequence number (timestamp) bytes must be at the 1st item of each frame.
  }
  export interface Props {
    configs: DisruptorConfig[];
  }

  export type OnReceiveData = (index: number, buf: Buffer, offset: number) => void;
}

export class DisruptorMaintainer {
  currentBuf: Buffer[] = [];
  protected config: DisruptorDistributor.DisruptorConfig;
  protected instance: DisruptorClass;
  protected processedDataLen = 0;
  protected currentBufIndex = 0;
  protected currentDataOffset = 0;
  protected lastPeekOffset = -1;
  protected lastPeekValue = 0;
  isFinished = false;

  constructor(config: DisruptorDistributor.DisruptorConfig) {
    this.config = config;
    const { queueName, numElements, consumersCount, consumerIndex, elementSize } = config;
    const init = false;
    const spin = true;
    this.instance = new Disruptor(
      queueName,
      numElements,
      elementSize,
      consumersCount,
      consumerIndex,
      init, // as a consumer, don't init it
      spin, // If true then methods on this object which read from the Disruptor won't return to your application until a value is ready
    );
  }

  async loadNext() {
    const { bufs } = await this.instance.consumeNew();
    this.currentBuf = bufs;
    this.currentDataOffset = 0;
    this.currentBufIndex = 0;
    // must reset this in case the data length is 1
    this.lastPeekOffset = -1;
  }

  // peek next buf ts from queue
  peek(): number {
    // cache to peek result, don't run readUIntLE every time. not sure how much difference it makes
    if (this.lastPeekOffset === this.currentDataOffset) {
      return this.lastPeekValue;
    }
    const buf = this.currentBuf[this.currentBufIndex];
    this.lastPeekOffset = this.currentDataOffset;
    this.lastPeekValue = buf.readUIntLE(this.currentDataOffset, this.config.sequenceBytes);
    return this.lastPeekValue;
  }

  // remove one buff from queue, and return it
  remove() {
    if (this.currentBufIndex >= this.currentBuf.length) {
      throw new Error(`cannot remove due to currentBufIndex exceeds buf length`);
    }
    const buf = this.currentBuf[this.currentBufIndex];
    const res = {
      buf,
      offset: this.currentDataOffset,
    };
    this.currentDataOffset += this.config.elementSize;
    if (this.currentDataOffset >= buf.length) {
      this.currentBufIndex++;
      this.currentDataOffset = 0;
    }
    this.processedDataLen++;
    return res;
  }

  getProcessedDataLen() {
    return this.processedDataLen;
  }

  usedAllCache(): boolean {
    return this.currentBufIndex >= this.currentBuf.length;
  }

  needFetchCache(): boolean {
    return this.usedAllCache() && !this.isDone();
  }

  async completeCache() {
    await this.instance.consumeCommit();
  }

  isDone() {
    return this.processedDataLen >= this.config.dataLen;
  }
}

export class DisruptorDistributor {
  protected disStatus: DisruptorMaintainer[];
  configs: DisruptorDistributor.DisruptorConfig[];
  protected lastSequenceNumber = 0;
  constructor(props: DisruptorDistributor.Props) {
    const { configs } = props;
    this.configs = configs;
    this.disStatus = configs.map(config => {
      return new DisruptorMaintainer(config);
    });
  }

  protected allDisruptorFinished() {
    for (const disStatus of this.disStatus) {
      if (!disStatus.isDone()) return false;
    }
    return true;
  }

  protected allDisruptorHaveCache() {
    for (const disStatus of this.disStatus) {
      if (disStatus.usedAllCache() && !disStatus.isDone()) return false;
    }
    return true;
  }

  protected feedCacheUntilCacheRunOut(onReceiveData: DisruptorDistributor.OnReceiveData) {
    while (this.allDisruptorHaveCache() && !this.allDisruptorFinished()) {
      let currentMinSequence = Number.MAX_SAFE_INTEGER;
      let currentMinSequenceIndex = 0;
      for (let i = 0; i < this.disStatus.length; i++) {
        const disStatus = this.disStatus[i];
        if (disStatus.isDone()) continue;
        const seq = disStatus.peek();
        if (seq < currentMinSequence) {
          currentMinSequence = seq;
          currentMinSequenceIndex = i;
        }
      }

      // feed data from lastMinTsIndex
      const { buf, offset } = this.disStatus[currentMinSequenceIndex].remove();
      if (this.lastSequenceNumber && currentMinSequence < this.lastSequenceNumber) {
        throw new Error(
          `invalid sequence currentMinSequenceIndex=${currentMinSequenceIndex} current=${currentMinSequence}, last=${this.lastSequenceNumber}`,
        );
      }
      this.lastSequenceNumber = currentMinSequence;

      // now this needs to be consumed by external program
      onReceiveData(currentMinSequenceIndex, buf, offset);
    }
  }

  async run(onReceiveData: DisruptorDistributor.OnReceiveData) {
    // make sure all data in queue has some data, if any data is missing, and it's not over yet, wait for some data is ready.
    while (!this.allDisruptorFinished()) {
      // load some data in every disStatus
      for (let i = 0; i < this.disStatus.length; i++) {
        const disStatus = this.disStatus[i];
        if (disStatus.needFetchCache()) {
          await disStatus.loadNext();
        }
      }
      // start taking data from dis cache, until at least one runs out.
      this.feedCacheUntilCacheRunOut(onReceiveData);
      for (let i = 0; i < this.disStatus.length; i++) {
        const disStatus = this.disStatus[i];
        if (disStatus.usedAllCache() && !disStatus.isFinished) {
          await disStatus.completeCache();
          disStatus.isFinished = disStatus.isDone();
        }
      }
    }
  }
}

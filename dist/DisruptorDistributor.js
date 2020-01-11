"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const { Disruptor } = require('shared-memory-disruptor');
class DisruptorMaintainer {
    constructor(config) {
        this.currentBuf = [];
        this.processedDataLen = 0;
        this.currentBufIndex = 0;
        this.currentDataOffset = 0;
        this.lastPeekOffset = -1;
        this.lastPeekValue = 0;
        this.isFinished = false;
        this.config = config;
        const { queueName, numElements, consumersCount, consumerIndex, elementSize } = config;
        const init = false;
        const spin = true;
        this.instance = new Disruptor(queueName, numElements, elementSize, consumersCount, consumerIndex, init, // as a consumer, don't init it
        spin);
    }
    loadNext() {
        return __awaiter(this, void 0, void 0, function* () {
            const { bufs } = yield this.instance.consumeNew();
            this.currentBuf = bufs;
            this.currentDataOffset = 0;
            this.currentBufIndex = 0;
            // must reset this in case the data length is 1
            this.lastPeekOffset = -1;
        });
    }
    // peek next buf ts from queue
    peek() {
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
    usedAllCache() {
        return this.currentBufIndex >= this.currentBuf.length;
    }
    needFetchCache() {
        return this.usedAllCache() && !this.isDone();
    }
    completeCache() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.instance.consumeCommit();
        });
    }
    isDone() {
        return this.processedDataLen >= this.config.dataLen;
    }
}
exports.DisruptorMaintainer = DisruptorMaintainer;
class DisruptorDistributor {
    constructor(props) {
        this.lastSequenceNumber = 0;
        const { configs } = props;
        this.configs = configs;
        this.disStatus = configs.map(config => {
            return new DisruptorMaintainer(config);
        });
    }
    allDisruptorFinished() {
        for (const disStatus of this.disStatus) {
            if (!disStatus.isDone())
                return false;
        }
        return true;
    }
    allDisruptorHaveCache() {
        for (const disStatus of this.disStatus) {
            if (disStatus.usedAllCache())
                return false;
        }
        return true;
    }
    feedCacheUntilCacheRunOut(onReceiveData) {
        while (this.allDisruptorHaveCache()) {
            let currentMinSequence = Number.MAX_SAFE_INTEGER;
            let currentMinSequenceIndex = 0;
            for (let i = 0; i < this.disStatus.length; i++) {
                const disStatus = this.disStatus[i];
                if (disStatus.isDone())
                    continue;
                const seq = disStatus.peek();
                if (seq < currentMinSequence) {
                    currentMinSequence = seq;
                    currentMinSequenceIndex = i;
                }
            }
            // feed data from lastMinTsIndex
            const { buf, offset } = this.disStatus[currentMinSequenceIndex].remove();
            if (this.lastSequenceNumber && currentMinSequence < this.lastSequenceNumber) {
                throw new Error(`invalid sequence currentMinSequenceIndex=${currentMinSequenceIndex} current=${currentMinSequence}, last=${this.lastSequenceNumber}`);
            }
            this.lastSequenceNumber = currentMinSequence;
            // now this needs to be consumed by external program
            onReceiveData(currentMinSequenceIndex, buf, offset);
        }
    }
    run(onReceiveData) {
        return __awaiter(this, void 0, void 0, function* () {
            // make sure all data in queue has some data, if any data is missing, and it's not over yet, wait for some data is ready.
            while (!this.allDisruptorFinished()) {
                // load some data in every disStatus
                for (let i = 0; i < this.disStatus.length; i++) {
                    const disStatus = this.disStatus[i];
                    if (disStatus.needFetchCache()) {
                        yield disStatus.loadNext();
                    }
                }
                // start taking data from dis cache, until at least one runs out.
                this.feedCacheUntilCacheRunOut(onReceiveData);
                for (let i = 0; i < this.disStatus.length; i++) {
                    const disStatus = this.disStatus[i];
                    if (disStatus.usedAllCache() && !disStatus.isFinished) {
                        yield disStatus.completeCache();
                        disStatus.isFinished = disStatus.isDone();
                    }
                }
            }
        });
    }
}
exports.DisruptorDistributor = DisruptorDistributor;

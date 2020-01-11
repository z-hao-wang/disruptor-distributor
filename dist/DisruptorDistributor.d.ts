/// <reference types="node" />
declare class DisruptorClass {
    constructor(shm_name: string, num_elements: number, element_size: number, num_consumers: number, consumer: number, init: boolean, spin: boolean);
    consumeNew(): Promise<{
        bufs: Buffer[];
    }>;
    consumeCommit(): Promise<boolean>;
}
export declare namespace DisruptorDistributor {
    interface DisruptorConfig {
        queueName: string;
        numElements: number;
        consumersCount: number;
        consumerIndex: number;
        elementSize: number;
        dataLen: number;
        sequenceBytes: number;
    }
    interface Props {
        configs: DisruptorConfig[];
    }
    type OnReceiveData = (index: number, buf: Buffer, offset: number) => void;
}
export declare class DisruptorMaintainer {
    currentBuf: Buffer[];
    protected config: DisruptorDistributor.DisruptorConfig;
    protected instance: DisruptorClass;
    protected processedDataLen: number;
    protected currentBufIndex: number;
    protected currentDataOffset: number;
    protected lastPeekOffset: number;
    protected lastPeekValue: number;
    isFinished: boolean;
    constructor(config: DisruptorDistributor.DisruptorConfig);
    loadNext(): Promise<void>;
    peek(): number;
    remove(): {
        buf: Buffer;
        offset: number;
    };
    getProcessedDataLen(): number;
    usedAllCache(): boolean;
    needFetchCache(): boolean;
    completeCache(): Promise<void>;
    isDone(): boolean;
}
export declare class DisruptorDistributor {
    disStatus: DisruptorMaintainer[];
    configs: DisruptorDistributor.DisruptorConfig[];
    lastSequenceNumber: number;
    constructor(props: DisruptorDistributor.Props);
    allDisruptorFinished(): boolean;
    allDisruptorHaveCache(): boolean;
    feedCacheUntilCacheRunOut(onReceiveData: DisruptorDistributor.OnReceiveData): void;
    run(onReceiveData: DisruptorDistributor.OnReceiveData): Promise<void>;
}
export {};

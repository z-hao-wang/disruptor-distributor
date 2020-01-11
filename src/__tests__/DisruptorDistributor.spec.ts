import { DisruptorDistributor } from '../DisruptorDistributor';
const { Disruptor } = require('shared-memory-disruptor');

describe('disruptorDistributor', () => {
  let numElements = 256;
  let consumersCount = 1;
  let elementSize = 10;
  let dataLen = 1000;
  async function initProvider(startingIndex = 0) {
    const d = new Disruptor(`test-${startingIndex}`, numElements, elementSize, 1, -1, true, true);
    let sum = 0;
    for (let i = startingIndex; i <= dataLen * 2; i += 2) {
      const { buf } = await d.produceClaim();
      buf.writeUIntLE(i, 0, 6);
      const float = Math.random();
      buf.writeFloatLE(float, 6);
      await d.produceCommit(); // (3)
      sum += float;
    }
    return sum;
  }

  it('can distribute items based on sequence number', async () => {
    const producer1 = initProvider(0);
    const producer2 = initProvider(1);
    const configs = [
      {
        queueName: 'test-0',
        // how many num elements in Disruptor cache, capacity
        numElements, // Total number of objects that will be reading data from the Disruptor.
        consumersCount,
        consumerIndex: 0,
        elementSize,
        sequenceBytes: 6,
        dataLen,
      },
      {
        queueName: 'test-1',
        // how many num elements in Disruptor cache, capacity
        numElements, // Total number of objects that will be reading data from the Disruptor.
        consumersCount,
        consumerIndex: 0,
        elementSize,
        sequenceBytes: 6,
        dataLen,
      },
    ];
    let sumConsumer = 0;
    let lastSequenceNum = 0;
    const distributor = new DisruptorDistributor({ configs });
    function onReceiveData(index: number, buf: Buffer, offset: number, currentMinSequence: number) {
      const sequenceNum = buf.readUIntLE(offset, 6);
      if (sequenceNum < lastSequenceNum) {
        throw new Error(`sequence out of order lastSequenceNum=${lastSequenceNum}, sequenceNum=${sequenceNum}`);
        // console.log(`sequence out of order lastSequenceNum=${lastSequenceNum}, sequenceNum=${sequenceNum} currentMinSequence=${currentMinSequence}`);
      }
      lastSequenceNum = sequenceNum;
      const float = buf.readFloatLE(offset + 6);
      sumConsumer += float;
    }

    await distributor.run(onReceiveData);
    const [sum1, sum2] = await Promise.all([producer1, producer2]);
    const sumExpected = sum1 + sum2;
    expect((sumConsumer - sumExpected) / (sumExpected + sumConsumer) < 0.01).toBe(true);
  });
});

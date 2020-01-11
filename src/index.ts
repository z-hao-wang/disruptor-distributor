import * as _ from 'lodash';

export function sampleFunc(input: number[]) {
  return _.filter(input, i => i > 0);
}

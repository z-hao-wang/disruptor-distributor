"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const _ = require("lodash");
function sampleFunc(input) {
    return _.filter(input, i => i > 0);
}
exports.sampleFunc = sampleFunc;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasIntegratedGraphics } from '../server/media/gpu.js';

test('integrated graphics detection from CPU names', () => {
  const cases = [
    // Intel: everything but F/KF models
    ['Intel(R) Core(TM) i5-12400 CPU @ 2.50GHz', true],
    ['Intel(R) Core(TM) i5-12400F', false],
    ['Intel(R) Core(TM) i7-9700KF CPU @ 3.60GHz', false],
    ['Intel(R) Core(TM) Ultra 7 155H', true],
    ['Intel(R) N100', true],
    ['Intel(R) Pentium(R) Gold G6400 CPU @ 4.00GHz', true],
    ['Intel(R) Xeon(R) E-2278G CPU @ 3.40GHz', true],
    ['Intel(R) Xeon(R) Silver 4210 CPU @ 2.20GHz', null],
    // AMD: APUs, "Radeon Graphics" in the name, and Ryzen 7000+ except F models
    ['AMD Ryzen 5 3600 6-Core Processor', false],
    ['AMD Ryzen 7 5800X 8-Core Processor', false],
    ['AMD Ryzen 7 5700G with Radeon Graphics', true],
    ['AMD Ryzen 5 3400G with Radeon Vega Graphics', true],
    ['AMD Ryzen 7 7700X 8-Core Processor', true],
    ['AMD Ryzen 5 7500F 6-Core Processor', false],
    ['AMD Ryzen 9 9950X 16-Core Processor', true],
    ['AMD Ryzen Threadripper 3970X 32-Core Processor', false],
    ['ARM Cortex-A76', null],
    [null, null],
  ];
  for (const [name, expected] of cases) assert.equal(hasIntegratedGraphics(name), expected, String(name));
});

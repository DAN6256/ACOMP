import assert from 'node:assert/strict';
import { it } from 'node:test';
import { hexToBin } from '../src/lib/intelHex.js';

// Builds a valid record so tests read as data, not hand-computed checksums.
function record(type, address, bytes = []) {
  const body = Buffer.from([bytes.length, (address >> 8) & 0xff, address & 0xff, type, ...bytes]);
  const checksum = (0x100 - body.reduce((a, b) => (a + b) & 0xff, 0)) & 0xff;
  return ':' + Buffer.concat([body, Buffer.from([checksum])]).toString('hex').toUpperCase();
}
const EOF = ':00000001FF';

it('converts a real AVR record (first line of an Uno blink .hex)', () => {
  const { data, loadAddress } = hexToBin(':100000000C945C000C946E000C946E000C946E00CA\r\n' + EOF + '\r\n');
  assert.equal(loadAddress, 0);
  assert.equal(data.toString('hex'), '0c945c000c946e000c946e000c946e00');
});

it('joins consecutive records and fills gaps with 0xFF', () => {
  const hex = [record(0, 0x0000, [1, 2]), record(0, 0x0002, [3]), record(0, 0x0006, [9]), EOF].join('\n');
  const { data } = hexToBin(hex);
  assert.deepEqual([...data], [1, 2, 3, 0xff, 0xff, 0xff, 9]);
});

it('handles extended linear addresses and reports the load address', () => {
  // ARM-style image at 0x08000000
  const hex = [record(4, 0, [0x08, 0x00]), record(0, 0x0000, [0xaa, 0xbb]), record(5, 0, [8, 0, 0, 0]), EOF].join('\n');
  const { data, loadAddress } = hexToBin(hex);
  assert.equal(loadAddress, 0x08000000);
  assert.deepEqual([...data], [0xaa, 0xbb]);
});

it('handles extended segment addresses', () => {
  const hex = [record(2, 0, [0x10, 0x00]), record(0, 0x0004, [7]), EOF].join('\n');
  assert.equal(hexToBin(hex).loadAddress, 0x10004);
});

it('ignores anything after the end-of-file record', () => {
  const { data } = hexToBin([record(0, 0, [5]), EOF, 'garbage'].join('\n'));
  assert.deepEqual([...data], [5]);
});

it('rejects a bad checksum', () => {
  assert.throws(() => hexToBin(':100000000C945C000C946E000C946E000C946E00CB\n' + EOF), /Checksum error at line 1/);
});

it('rejects malformed lines, length mismatches and a missing EOF', () => {
  assert.throws(() => hexToBin('hello\n' + EOF), /Invalid Intel HEX record/);
  assert.throws(() => hexToBin(':0500000001FA\n' + EOF), /Record length mismatch/);
  assert.throws(() => hexToBin(record(0, 0, [1])), /Missing end-of-file/);
});

it('refuses images that would be unreasonably large', () => {
  const hex = [record(0, 0, [1]), record(4, 0, [0x08, 0x00]), record(0, 0, [2]), EOF].join('\n');
  assert.throws(() => hexToBin(hex), /byte limit/);
});

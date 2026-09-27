// Largest image we will build from a .hex file. Guards against a file whose
// addresses are far apart (e.g. data placed at 0x08000000) blowing up memory.
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/**
 * Converts Intel HEX text into a flat binary image.
 *
 * The image starts at the lowest address in the file (`loadAddress`); gaps
 * between records are filled with 0xFF, which is what erased flash reads as.
 * Supports record types 00 (data), 01 (end of file), 02 (extended segment
 * address) and 04 (extended linear address); 03/05 (start address) are ignored.
 *
 * @param {string | Buffer} hex
 * @returns {{ data: Buffer, loadAddress: number }}
 */
export function hexToBin(hex) {
  const chunks = [];
  let base = 0;
  let sawEof = false;

  const lines = hex.toString('ascii').split(/\r?\n/);
  for (let i = 0; i < lines.length && !sawEof; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    const where = `line ${i + 1}`;

    if (!/^:([0-9A-Fa-f]{2})+$/.test(line) || line.length < 11) {
      throw new Error(`Invalid Intel HEX record at ${where}`);
    }
    const bytes = Buffer.from(line.slice(1), 'hex');
    const count = bytes[0];
    if (bytes.length !== count + 5) throw new Error(`Record length mismatch at ${where}`);
    const sum = bytes.reduce((acc, b) => (acc + b) & 0xff, 0);
    if (sum !== 0) throw new Error(`Checksum error at ${where}`);

    const offset = bytes.readUInt16BE(1);
    const type = bytes[3];
    const payload = bytes.subarray(4, 4 + count);

    switch (type) {
      case 0x00:
        chunks.push({ address: base + offset, payload });
        break;
      case 0x01:
        sawEof = true;
        break;
      case 0x02:
        base = payload.readUInt16BE(0) * 16;
        break;
      case 0x04:
        base = payload.readUInt16BE(0) * 0x10000;
        break;
      case 0x03:
      case 0x05:
        break;
      default:
        throw new Error(`Unsupported record type 0x${type.toString(16).padStart(2, '0')} at ${where}`);
    }
  }

  if (!sawEof) throw new Error('Missing end-of-file record');
  if (chunks.length === 0) return { data: Buffer.alloc(0), loadAddress: 0 };

  const start = Math.min(...chunks.map((c) => c.address));
  const end = Math.max(...chunks.map((c) => c.address + c.payload.length));
  if (end - start > MAX_IMAGE_BYTES) {
    throw new Error(`Image spans ${end - start} bytes, more than the ${MAX_IMAGE_BYTES} byte limit`);
  }

  const data = Buffer.alloc(end - start, 0xff);
  for (const c of chunks) c.payload.copy(data, c.address - start);
  return { data, loadAddress: start };
}

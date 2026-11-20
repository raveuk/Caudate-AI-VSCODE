/*---------------------------------------------------------------------------------------------
 *  Generates a crisp multi-resolution Windows .ico icon for Caudate IDE (PNG-in-ICO).
 *--------------------------------------------------------------------------------------------*/
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		c ^= buf[i];
		for (let k = 0; k < 8; k++) {
			c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
		}
	}
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const typeBuf = Buffer.from(type, 'ascii');
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
	return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function renderCaudatePng(size) {
	const raw = Buffer.alloc(size * (1 + size * 4));
	const cx = size / 2;
	const cy = size / 2;
	const rCorner = size * 0.22;

	for (let y = 0; y < size; y++) {
		const rowOff = y * (1 + size * 4);
		raw[rowOff] = 0;
		for (let x = 0; x < size; x++) {
			const off = rowOff + 1 + x * 4;
			const dx = Math.max(Math.abs(x + 0.5 - cx) - (size / 2 - rCorner - 1), 0);
			const dy = Math.max(Math.abs(y + 0.5 - cy) - (size / 2 - rCorner - 1), 0);
			const dist = Math.hypot(dx, dy) - rCorner;
			if (dist > 0.7) {
				raw[off] = 0; raw[off + 1] = 0; raw[off + 2] = 0; raw[off + 3] = 0;
				continue;
			}
			const bgAlpha = Math.max(0, Math.min(1, 0.7 - dist));

			const nx = (x + 0.5) / size;
			const ny = (y + 0.5) / size;

			// Dark slate gradient
			let r = Math.round(22 - ny * 8);
			let g = Math.round(25 - ny * 9);
			let b = Math.round(33 - ny * 11);

			// Subtle blue ambient glow
			const glow = Math.max(0, 1 - Math.hypot(nx - 0.65, ny - 0.5) * 1.9);
			r = Math.min(255, Math.round(r + glow * 14));
			g = Math.min(255, Math.round(g + glow * 38));
			b = Math.min(255, Math.round(b + glow * 72));

			// Geometric "C" ring centered at (0.48, 0.5) with right opening
			const rx = nx - 0.48;
			const ry = ny - 0.50;
			const rad = Math.hypot(rx, ry);
			const angle = Math.atan2(ry, rx); // -PI..PI, 0 is right
			const inRing = rad >= 0.16 && rad <= 0.305 && Math.abs(angle) > 0.66;

			// Accent dot inside right opening of the "C"
			const dotDist = Math.hypot(nx - 0.74, ny - 0.50);
			const inDot = dotDist <= 0.062;

			if (inRing) {
				r = 246; g = 249; b = 255;
			} else if (inDot) {
				r = 56; g = 139; b = 253;
			}

			raw[off] = r;
			raw[off + 1] = g;
			raw[off + 2] = b;
			raw[off + 3] = Math.round(bgAlpha * 255);
		}
	}

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

	const idat = zlib.deflateSync(raw, { level: 9 });
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		pngChunk('IHDR', ihdr),
		pngChunk('IDAT', idat),
		pngChunk('IEND', Buffer.alloc(0)),
	]);
}

function buildIco(sizes) {
	const pngs = sizes.map(s => ({ size: s, data: renderCaudatePng(s) }));
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(pngs.length, 4);

	const entries = [];
	let offset = 6 + pngs.length * 16;
	for (const p of pngs) {
		const entry = Buffer.alloc(16);
		entry[0] = p.size >= 256 ? 0 : p.size;
		entry[1] = p.size >= 256 ? 0 : p.size;
		entry[2] = 0;
		entry[3] = 0;
		entry.writeUInt16LE(1, 4);
		entry.writeUInt16LE(32, 6);
		entry.writeUInt32LE(p.data.length, 8);
		entry.writeUInt32LE(offset, 12);
		entries.push(entry);
		offset += p.data.length;
	}

	return Buffer.concat([header, ...entries, ...pngs.map(p => p.data)]);
}

const root = path.resolve(import.meta.dirname, '..');
const ico = buildIco([16, 32, 48, 64, 128, 256]);
for (const rel of ['resources/win32/code.ico', 'resources/win32/caudate.ico']) {
	fs.writeFileSync(path.join(root, rel), ico);
	console.log('Generated icon:', rel, ico.length, 'bytes');
}

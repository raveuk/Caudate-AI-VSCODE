/*---------------------------------------------------------------------------------------------
 *  Generates branded Inno Setup wizard bitmaps (24-bit BMP) for Caudate IDE.
 *--------------------------------------------------------------------------------------------*/
import fs from 'fs';
import path from 'path';

function writeBmp24(filePath, width, height, pixelFn) {
	const rowStride = Math.ceil((width * 3) / 4) * 4;
	const imageSize = rowStride * height;
	const fileSize = 54 + imageSize;
	const buf = Buffer.alloc(fileSize);

	// BITMAPFILEHEADER
	buf.write('BM', 0, 'ascii');
	buf.writeUInt32LE(fileSize, 2);
	buf.writeUInt32LE(54, 10);

	// BITMAPINFOHEADER
	buf.writeUInt32LE(40, 14);
	buf.writeInt32LE(width, 18);
	buf.writeInt32LE(height, 22); // bottom-up
	buf.writeUInt16LE(1, 26);
	buf.writeUInt16LE(24, 28);
	buf.writeUInt32LE(0, 30);
	buf.writeUInt32LE(imageSize, 34);
	buf.writeInt32LE(2835, 38);
	buf.writeInt32LE(2835, 42);

	for (let y = 0; y < height; y++) {
		const bmpRow = height - 1 - y;
		const rowOff = 54 + bmpRow * rowStride;
		for (let x = 0; x < width; x++) {
			const [r, g, b] = pixelFn(x, y, width, height);
			const off = rowOff + x * 3;
			buf[off] = Math.max(0, Math.min(255, Math.round(b)));
			buf[off + 1] = Math.max(0, Math.min(255, Math.round(g)));
			buf[off + 2] = Math.max(0, Math.min(255, Math.round(r)));
		}
	}

	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, buf);
}

function renderBigWizardPixel(x, y, w, h) {
	const nx = (x + 0.5) / w;
	const ny = (y + 0.5) / h;

	// Deep midnight slate vertical gradient
	let r = 14 + (1 - ny) * 10;
	let g = 18 + (1 - ny) * 12;
	let b = 28 + (1 - ny) * 18;

	// Subtle luminous blue glow behind the upper emblem
	const emblemCx = 0.5;
	const emblemCy = 0.34;
	const aspect = w / h;
	const dxG = (nx - emblemCx) * aspect;
	const dyG = ny - emblemCy;
	const glow = Math.max(0, 1 - Math.hypot(dxG, dyG) * 2.5);
	r += glow * 16;
	g += glow * 44;
	b += glow * 88;

	// Secondary subtle cyan-blue glow near lower-right corner
	const glow2 = Math.max(0, 1 - Math.hypot((nx - 0.85) * aspect, ny - 0.88) * 2.4);
	r += glow2 * 10;
	g += glow2 * 28;
	b += glow2 * 54;

	// Subtle decorative grid lines in lower third
	if (ny > 0.68) {
		const fade = (ny - 0.68) / 0.32;
		const gx = Math.abs(((x % Math.max(12, Math.round(w / 8))) / Math.max(12, Math.round(w / 8))) - 0.5);
		const gy = Math.abs(((y % Math.max(12, Math.round(w / 8))) / Math.max(12, Math.round(w / 8))) - 0.5);
		if (gx < 0.04 || gy < 0.04) {
			r += 10 * fade;
			g += 22 * fade;
			b += 42 * fade;
		}
	}

	// Crisp right edge accent border (1-2px)
	if (x >= w - Math.max(1, Math.round(w * 0.012))) {
		r = 45;
		g = 110;
		b = 205;
	}

	// Rounded dark icon badge centered at (emblemCx, emblemCy)
	const badgeSize = w * 0.58;
	const bx = x + 0.5 - w * emblemCx;
	const by = y + 0.5 - h * emblemCy;
	const rCorner = badgeSize * 0.22;
	const bdx = Math.max(Math.abs(bx) - (badgeSize / 2 - rCorner), 0);
	const bdy = Math.max(Math.abs(by) - (badgeSize / 2 - rCorner), 0);
	const bDist = Math.hypot(bdx, bdy) - rCorner;

	if (bDist <= 1.2) {
		const inBadge = Math.max(0, Math.min(1, 0.8 - bDist));
		const bnx = (bx + badgeSize / 2) / badgeSize;
		const bny = (by + badgeSize / 2) / badgeSize;

		let br = 22 - bny * 7;
		let bg = 26 - bny * 8;
		let bb = 36 - bny * 10;

		const iGlow = Math.max(0, 1 - Math.hypot(bnx - 0.65, bny - 0.5) * 1.9);
		br += iGlow * 14;
		bg += iGlow * 38;
		bb += iGlow * 72;

		// Subtle 1px rim highlight on badge
		if (bDist > -1.5 && bDist <= 0.3) {
			br += 24;
			bg += 56;
			bb += 104;
		}

		// Geometric "C" ring
		const rx = bnx - 0.48;
		const ry = bny - 0.50;
		const rad = Math.hypot(rx, ry);
		const angle = Math.atan2(ry, rx);
		if (rad >= 0.16 && rad <= 0.305 && Math.abs(angle) > 0.66) {
			br = 246; bg = 249; bb = 255;
		} else if (Math.hypot(bnx - 0.74, bny - 0.50) <= 0.064) {
			br = 56; bg = 139; bb = 253;
		}

		r = r * (1 - inBadge) + br * inBadge;
		g = g * (1 - inBadge) + bg * inBadge;
		b = b * (1 - inBadge) + bb * inBadge;
	}

	// Clean horizontal accent bar below emblem
	const barY = h * 0.54;
	const barH = Math.max(2, h * 0.008);
	const barW = w * 0.34;
	if (Math.abs(y + 0.5 - barY) <= barH / 2 && Math.abs(x + 0.5 - w / 2) <= barW / 2) {
		r = 56; g = 139; b = 253;
	}

	return [r, g, b];
}

function renderSmallWizardPixel(x, y, w, h) {
	// Crisp white header background matching Inno Setup modern top bar
	let r = 255, g = 255, b = 255;

	const size = Math.min(w, h) * 0.86;
	const cx = w / 2;
	const cy = h / 2;
	const bx = x + 0.5 - cx;
	const by = y + 0.5 - cy;
	const rCorner = size * 0.22;
	const bdx = Math.max(Math.abs(bx) - (size / 2 - rCorner), 0);
	const bdy = Math.max(Math.abs(by) - (size / 2 - rCorner), 0);
	const bDist = Math.hypot(bdx, bdy) - rCorner;

	if (bDist <= 0.8) {
		const alpha = Math.max(0, Math.min(1, 0.8 - bDist));
		const bnx = (bx + size / 2) / size;
		const bny = (by + size / 2) / size;

		let br = 22 - bny * 8;
		let bg = 25 - bny * 9;
		let bb = 33 - bny * 11;

		const glow = Math.max(0, 1 - Math.hypot(bnx - 0.65, bny - 0.5) * 1.9);
		br += glow * 14;
		bg += glow * 38;
		bb += glow * 72;

		const rx = bnx - 0.48;
		const ry = bny - 0.50;
		const rad = Math.hypot(rx, ry);
		const angle = Math.atan2(ry, rx);
		if (rad >= 0.16 && rad <= 0.305 && Math.abs(angle) > 0.66) {
			br = 246; bg = 249; bb = 255;
		} else if (Math.hypot(bnx - 0.74, bny - 0.50) <= 0.065) {
			br = 56; bg = 139; bb = 253;
		}

		r = r * (1 - alpha) + br * alpha;
		g = g * (1 - alpha) + bg * alpha;
		b = b * (1 - alpha) + bb * alpha;
	}

	return [r, g, b];
}

const bigTargets = [
	['resources/win32/inno-big-100.bmp', 164, 314],
	['resources/win32/inno-big-125.bmp', 192, 386],
	['resources/win32/inno-big-150.bmp', 246, 459],
	['resources/win32/inno-big-175.bmp', 273, 556],
	['resources/win32/inno-big-200.bmp', 328, 604],
	['resources/win32/inno-big-225.bmp', 355, 700],
	['resources/win32/inno-big-250.bmp', 410, 797],
];

const smallTargets = [
	['resources/win32/inno-small-100.bmp', 55, 55],
	['resources/win32/inno-small-125.bmp', 64, 68],
	['resources/win32/inno-small-150.bmp', 83, 80],
	['resources/win32/inno-small-175.bmp', 92, 97],
	['resources/win32/inno-small-200.bmp', 110, 106],
	['resources/win32/inno-small-225.bmp', 119, 123],
	['resources/win32/inno-small-250.bmp', 138, 140],
];

for (const [file, w, h] of bigTargets) {
	writeBmp24(file, w, h, renderBigWizardPixel);
	console.log(`Generated ${file} (${w}x${h})`);
}
for (const [file, w, h] of smallTargets) {
	writeBmp24(file, w, h, renderSmallWizardPixel);
	console.log(`Generated ${file} (${w}x${h})`);
}

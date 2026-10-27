import { deflateSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const imageDirectory = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../com.gently.f1-track-requests.sdPlugin/imgs",
);

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
	const name = Buffer.from(type, "ascii");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
	return Buffer.concat([length, name, data, checksum]);
}

function createIconPng(size) {
	const pixels = Buffer.alloc(size * size * 4);
	const scale = size / 256;

	function pixel(x, y, color) {
		x = Math.round(x * scale);
		y = Math.round(y * scale);
		if (x < 0 || y < 0 || x >= size || y >= size) return;
		pixels.set(color, (y * size + x) * 4);
	}

	function roundedRectangle(left, top, right, bottom, radius, color) {
		for (let y = top; y <= bottom; y++) {
			for (let x = left; x <= right; x++) {
				const cx = x < left + radius ? left + radius : x > right - radius ? right - radius : x;
				const cy = y < top + radius ? top + radius : y > bottom - radius ? bottom - radius : y;
				if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) pixel(x, y, color);
			}
		}
	}

	function circle(centerX, centerY, radius, color) {
		for (let y = centerY - radius; y <= centerY + radius; y++) {
			for (let x = centerX - radius; x <= centerX + radius; x++) {
				if ((x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2) pixel(x, y, color);
			}
		}
	}

	function line(x1, y1, x2, y2, width, color) {
		const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
		for (let step = 0; step <= steps; step++) {
			const x = x1 + (x2 - x1) * step / steps;
			const y = y1 + (y2 - y1) * step / steps;
			circle(x, y, width / 2, color);
		}
	}

	const navy = [25, 36, 58, 255];
	const white = [255, 255, 255, 255];
	const green = [57, 199, 121, 255];
	roundedRectangle(4, 4, 252, 252, 34, navy);
	roundedRectangle(56, 76, 195, 94, 8, white);
	roundedRectangle(56, 116, 195, 134, 8, white);
	roundedRectangle(56, 156, 142, 174, 8, white);
	circle(190, 185, 35, green);
	line(174, 185, 185, 196, 9, white);
	line(185, 196, 207, 170, 9, white);

	const scanlines = Buffer.alloc((size * 4 + 1) * size);
	for (let y = 0; y < size; y++) {
		const offset = y * (size * 4 + 1);
		scanlines[offset] = 0;
		pixels.copy(scanlines, offset + 1, y * size * 4, (y + 1) * size * 4);
	}

	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8;
	header[9] = 6;

	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(scanlines)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

await writeFile(resolve(imageDirectory, "plugin.png"), createIconPng(256));
await writeFile(resolve(imageDirectory, "plugin@2x.png"), createIconPng(512));

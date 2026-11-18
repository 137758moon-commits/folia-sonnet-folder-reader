import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseBuffer } from 'music-metadata';
import { parseDocumentMetadata } from '../../../src/services/nativeLocalMusic/documentMetadata';
import { DocumentRangeTokenizer, METADATA_RANGE_BYTES } from '../../../src/services/nativeLocalMusic/rangeTokenizer';
import { block, comments, flac, picture, png } from '../utils/flacMetadataFixtures';

// Parses real metadata against a virtual large file; any full-body read would fail these checks.

const url = `http://127.0.0.1:12345/audio/document-${'a'.repeat(64)}`;
const source = (fileSize: number, fileName = 'song.flac') => ({ url, fileSize, fileName });

function serveFile(head: Uint8Array, size: number, tail = new Uint8Array()) {
    const reads: Array<{ start: number; end: number }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
        const range = new Headers(options.headers).get('range');
        expect(range).toMatch(/^bytes=\d+-\d+$/);
        const [start, end] = range!.slice(6).split('-').map(Number);
        expect(end - start + 1).toBeLessThanOrEqual(METADATA_RANGE_BYTES);
        reads.push({ start, end });
        const data = new Uint8Array(end - start + 1);
        for (const [offset, bytes] of [[0, head], [size - tail.length, tail]] as const) {
            const from = Math.max(start, offset);
            const to = Math.min(end + 1, offset + bytes.length);
            if (to > from) data.set(bytes.subarray(from - offset, to - offset), from - start);
        }
        const response = new Response(data, {
            status: 206,
            headers: { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(data.length) },
        });
        vi.spyOn(response, 'blob').mockImplementation(() => { throw new Error('Audio Blob forbidden'); });
        return response;
    }));
    return reads;
}

function wavPackFixture(): Uint8Array {
    const blockSize = 64 * 1024;
    const audioBytes = 65 * 1024 * 1024;
    const title = Buffer.from('Original title');
    const item = Buffer.alloc(14 + title.length);
    item.writeUInt32LE(title.length, 0);
    item.write('Title\0', 8);
    title.copy(item, 14);
    const apeHeader = (flags: number) => {
        const bytes = Buffer.alloc(32);
        bytes.write('APETAGEX');
        bytes.writeUInt32LE(2000, 8);
        bytes.writeUInt32LE(item.length + 32, 12);
        bytes.writeUInt32LE(1, 16);
        bytes.writeUInt32LE(flags >>> 0, 20);
        return bytes;
    };
    const payload = Buffer.alloc(audioBytes + 64 + item.length);
    for (let position = 0; position < audioBytes; position += blockSize) {
        payload.write('wvpk', position);
        payload.writeUInt32LE(blockSize - 8, position + 4);
        payload.writeUInt16LE(0x410, position + 8);
        payload.writeUInt32LE(44100 * 600, position + 12);
        payload.writeUInt32LE((position / blockSize) * 22050, position + 16);
        payload.writeUInt32LE(22050, position + 20);
        payload.writeUInt32LE((9 << 23) | 1, position + 24);
    }
    // The first block contains a large dummy metadata sub-block; later audio blocks are skipped.
    payload[32] = 0x80;
    payload.writeUIntLE((blockSize - 36) / 2, 33, 3);
    apeHeader(0xa0000000).copy(payload, audioBytes);
    item.copy(payload, audioBytes + 32);
    apeHeader(0x80000000).copy(payload, audioBytes + 32 + item.length);
    return payload;
}

afterEach(() => vi.unstubAllGlobals());

describe('Android document metadata ranges', () => {
    it('reads tags, lyrics and a repaired embedded cover from a virtual 360 GiB FLAC without reading its audio', async () => {
        const file = flac([
            block(4, comments(['TITLE=Folder song', 'ARTIST=Local artist', 'LYRICS=[00:01.00]Keep the lyrics'])),
            block(6, picture({ mime: '', type: 250, dataLength: 0 }), true),
        ]);
        const size = 360 * 1024 ** 3;
        const reads = serveFile(new Uint8Array(await file.arrayBuffer()), size);
        const metadata = await parseDocumentMetadata(source(size), true);
        expect(metadata.common.title).toBe('Folder song');
        expect(metadata.common.artist).toBe('Local artist');
        expect(metadata.common.picture?.[0].data).toEqual(png);
        expect(metadata.common.lyrics?.[0].syncText?.[0].text).toBe('Keep the lyrics');
        expect(metadata.format.duration).toBe(10);
        expect(reads.reduce((sum, read) => sum + read.end - read.start + 1, 0)).toBeLessThanOrEqual(1024 * 1024);
        expect(reads.every(read => read.start < METADATA_RANGE_BYTES || read.start >= size - METADATA_RANGE_BYTES)).toBe(true);
    });

    it('seeks to ID3v1 tags at the end of an MP3 instead of assuming all tags are in the first chunk', async () => {
        const head = new Uint8Array(417 * 4);
        for (let i = 0; i < 4; i++) head.set([0xff, 0xfb, 0x90, 0], i * 417);
        const tail = new Uint8Array(128);
        const encoder = new TextEncoder();
        tail.set(encoder.encode('TAGFooter title'));
        tail.set(encoder.encode('Footer artist'), 33);
        const size = 64 * 1024 * 1024 + tail.length;
        const reads = serveFile(head, size, tail);
        const metadata = await parseDocumentMetadata(source(size, 'song.mp3'), true);
        expect(metadata.common.title).toBe('Footer title');
        expect(metadata.common.artist).toBe('Footer artist');
        expect(reads.reduce((sum, read) => sum + read.end - read.start + 1, 0)).toBeLessThanOrEqual(1024 * 1024);
    });

    it('preserves long WavPack tags and duration while reading sparse block headers', async () => {
        const payload = wavPackFixture();
        const original = await parseBuffer(payload, { mimeType: 'audio/wavpack' });
        expect(original.common.title).toBe('Original title');
        expect(original.format.duration).toBe(600);
        const reads = serveFile(payload, payload.length);
        const metadata = await parseDocumentMetadata({ ...source(payload.length, 'album.wv'), mimeType: 'audio/wavpack' }, true);
        expect(metadata.common.title).toBe(original.common.title);
        expect(metadata.format.duration).toBe(original.format.duration);
        expect(reads.reduce((sum, read) => sum + read.end - read.start + 1, 0)).toBeLessThan(5 * 1024 * 1024);
    });

    it('cancels a server that ignores Range without falling back to a full download', async () => {
        const cancelled = vi.fn();
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled }), { status: 200 })));
        const tokenizer = new DocumentRangeTokenizer(source(1024 * 1024));
        await expect(tokenizer.readBytes(0, 10)).rejects.toThrow('requested byte range');
        expect(cancelled).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledOnce();
        await tokenizer.close();
    });

    it.each(['short', 'long'])('rejects a %s range body', async mode => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(mode === 'short' ? 2 : 11), {
            status: 206, headers: { 'Content-Range': 'bytes 0-9/10', 'Content-Length': '10' },
        })));
        const tokenizer = new DocumentRangeTokenizer(source(10));
        await expect(tokenizer.readBytes(0, 1)).rejects.toThrow(mode === 'short' ? 'Truncated' : 'Oversized');
        await tokenizer.close();
    });

    it('refuses non-document and remote sources before fetching anything', () => {
        vi.stubGlobal('fetch', vi.fn());
        expect(() => new DocumentRangeTokenizer({ ...source(10), url: 'https://example.com/music.mp3' })).toThrow();
        expect(() => new DocumentRangeTokenizer({ ...source(10), url: 'http://127.0.0.1:12345/audio/local-1' })).toThrow();
        expect(fetch).not.toHaveBeenCalled();
    });
});

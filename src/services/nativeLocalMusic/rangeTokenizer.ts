import { AbstractTokenizer, EndOfStreamError } from 'strtok3/core';
import type { IRandomAccessFileInfo, IReadChunkOptions } from 'strtok3/core';

// Reads Android folder documents in bounded ranges without creating an audio Blob.

export interface DocumentMetadataSource {
    url: string;
    fileName: string;
    fileSize: number;
    mimeType?: string;
}

export const METADATA_RANGE_BYTES = 256 * 1024;
const MIN_METADATA_RANGE_BYTES = 4 * 1024;
const MAX_METADATA_ALLOCATION_BYTES = 64 * 1024 * 1024;

export class DocumentRangeTokenizer extends AbstractTokenizer {
    fileInfo: IRandomAccessFileInfo;
    private cache: Uint8Array = new Uint8Array();
    private cacheStart = 0;
    private prefix: Uint8Array = new Uint8Array();
    private originalPrefixSize = 0;
    private closed = false;
    private request: AbortController | undefined;

    constructor(private readonly source: DocumentMetadataSource) {
        super();
        const url = new URL(source.url);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
            || url.username || url.password || url.search || url.hash
            || !/^\/audio\/document-[0-9a-f]{64}$/.test(url.pathname)
            || !Number.isSafeInteger(source.fileSize) || source.fileSize <= 0) {
            throw new Error('Invalid Android document metadata source');
        }
        this.fileInfo = { size: source.fileSize, path: source.fileName, mimeType: source.mimeType };
    }

    supportsRandomAccess(): boolean { return true; }

    setPosition(position: number): void {
        if (!Number.isSafeInteger(position) || position < 0 || position > this.fileInfo.size) {
            throw new RangeError('Invalid metadata position');
        }
        this.position = position;
    }

    // A repaired FLAC metadata prefix can change length; the audio remains in the original file.
    replacePrefix(bytes: Uint8Array, originalSize: number): void {
        this.prefix = bytes;
        this.originalPrefixSize = originalSize;
        this.fileInfo.size = this.source.fileSize - originalSize + bytes.length;
        this.position = 0;
    }

    async readBuffer(buffer: Uint8Array, options?: IReadChunkOptions): Promise<number> {
        const position = options?.position ?? this.position;
        const read = await this.peekBuffer(buffer, options);
        this.position = position + read;
        return read;
    }

    async peekBuffer(buffer: Uint8Array, options?: IReadChunkOptions): Promise<number> {
        if (this.closed) throw new Error('Metadata source is closed');
        const { position, length, mayBeLess } = this.normalizeOptions(buffer, options);
        if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length)
            || length < 0 || length > buffer.length) throw new RangeError('Invalid metadata read');
        const available = Math.max(0, Math.min(this.fileInfo.size - position, length));
        if (!mayBeLess && available < length) throw new EndOfStreamError();
        let written = 0;
        while (written < available) {
            const offset = position + written;
            if (offset < this.prefix.length) {
                const count = Math.min(available - written, this.prefix.length - offset);
                buffer.set(this.prefix.subarray(offset, offset + count), written);
                written += count;
                continue;
            }
            const originalOffset = offset - this.prefix.length + this.originalPrefixSize;
            if (originalOffset < this.cacheStart || originalOffset >= this.cacheStart + this.cache.length) {
                await this.loadRange(originalOffset, available - written);
            }
            const start = originalOffset - this.cacheStart;
            const count = Math.min(available - written, this.cache.length - start);
            buffer.set(this.cache.subarray(start, start + count), written);
            written += count;
        }
        return written;
    }

    async readBytes(position: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
        if (length > MAX_METADATA_ALLOCATION_BYTES) throw new Error('Metadata allocation is too large');
        const bytes = new Uint8Array(length);
        await this.peekBuffer(bytes, { position });
        return bytes;
    }

    private async loadRange(position: number, requestedLength: number): Promise<void> {
        // Sparse block-header reads must not prefetch all the skipped audio (for example WavPack).
        const start = position;
        const requestedRange = Math.min(METADATA_RANGE_BYTES, Math.max(MIN_METADATA_RANGE_BYTES, requestedLength));
        const end = Math.min(start + requestedRange, this.source.fileSize) - 1;
        const length = end - start + 1;
        const controller = new AbortController();
        this.request = controller;
        const timeout = setTimeout(() => controller.abort(), 15_000);
        try {
            const response = await fetch(this.source.url, {
                headers: { Range: `bytes=${start}-${end}` },
                cache: 'no-store', credentials: 'omit', signal: controller.signal,
            });
            if (response.status !== 206
                || response.headers.get('content-range') !== `bytes ${start}-${end}/${this.source.fileSize}`
                || response.headers.get('content-length') !== String(length) || !response.body) {
                await response.body?.cancel();
                throw new Error('Document provider did not return the requested byte range');
            }
            const bytes = new Uint8Array(length);
            const reader = response.body.getReader();
            let received = 0;
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (received + value.length > length) throw new Error('Oversized document range');
                    bytes.set(value, received);
                    received += value.length;
                }
            } finally {
                reader.releaseLock();
            }
            if (received !== length) throw new Error('Truncated document range');
            this.cacheStart = start;
            this.cache = bytes;
        } finally {
            clearTimeout(timeout);
            controller.abort();
            this.request = undefined;
        }
    }

    override abort(): Promise<void> {
        this.closed = true;
        this.request?.abort();
        this.cache = new Uint8Array();
        this.prefix = new Uint8Array();
        return Promise.resolve();
    }
}

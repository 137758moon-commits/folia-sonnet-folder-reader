import { parseFromTokenizer } from 'music-metadata';
import type { IAudioMetadata } from 'music-metadata';
import { repairFlacMetadata } from '../../utils/flacMetadataRepair';
import { DocumentRangeTokenizer } from './rangeTokenizer';
import type { DocumentMetadataSource } from './rangeTokenizer';

// Keeps the existing tag parser and FLAC repairs while leaving audio bytes in the selected folder.

const MAX_FLAC_PREFIX_BYTES = 32 * 1024 * 1024;

async function prepareFlacPrefix(tokenizer: DocumentRangeTokenizer): Promise<void> {
    let flacOffset = 0;
    const size = tokenizer.fileInfo.size;
    if (size < 10) return;
    let preamble = await tokenizer.readBytes(0, 10);
    while (String.fromCharCode(...preamble.subarray(0, 3)) === 'ID3') {
        if (preamble[3] < 2 || preamble[3] > 4 || preamble.subarray(6).some(byte => byte & 0x80)) return;
        flacOffset += 10 + preamble[6] * 2097152 + preamble[7] * 16384 + preamble[8] * 128 + preamble[9];
        if (flacOffset > size - 10 || flacOffset > MAX_FLAC_PREFIX_BYTES) return;
        preamble = await tokenizer.readBytes(flacOffset, 10);
    }
    if (String.fromCharCode(...preamble.subarray(0, 4)) !== 'fLaC') return;
    let offset = flacOffset + 4;
    while (offset + 4 <= size && offset < MAX_FLAC_PREFIX_BYTES) {
        const header = await tokenizer.readBytes(offset, 4);
        const type = header[0] & 0x7f;
        const length = header[1] * 65536 + header[2] * 256 + header[3];
        const end = offset + 4 + length;
        if (type === 127 || end > size || end > MAX_FLAC_PREFIX_BYTES) return;
        if (header[0] & 0x80) {
            const prefix = await tokenizer.readBytes(0, end);
            const input = new Blob([prefix], { type: 'audio/flac' });
            const repaired = await repairFlacMetadata(input, true);
            tokenizer.replacePrefix(repaired === input ? prefix : new Uint8Array(await repaired.arrayBuffer()), end);
            return;
        }
        offset = end;
    }
}

export async function parseDocumentMetadata(source: DocumentMetadataSource, includeCover: boolean): Promise<IAudioMetadata> {
    const tokenizer = new DocumentRangeTokenizer(source);
    try {
        if (includeCover) await prepareFlacPrefix(tokenizer);
        return await parseFromTokenizer(tokenizer, { skipCovers: !includeCover });
    } finally {
        await tokenizer.close();
    }
}

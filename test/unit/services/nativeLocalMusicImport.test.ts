import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalSong } from '@/types';
import { copyAndroidLocalAudio, deleteAndroidImportedAudio, importExternalAudioTracks } from '@/services/nativeLocalMusic';
import { parseDocumentMetadataAsync } from '@/utils/localMetadataWorkerClient';
import { saveLocalSongs } from '@/services/db';

// test/unit/services/nativeLocalMusicImport.test.ts
// 「用 Folia 打开」第二次打开同一个文件时，曲库里已经有这首歌了 —— 那时新增的是 0 首，
// 但「加到歌单」这件事还得照做。以前这一步只返回「新写进去的」，0 首就意味着歌单一首
// 都没加，表现是「提示说已经在库里了，歌单里却一首都没有」。这里钉住 fresh / resolved 的语义。

const state = vi.hoisted(() => ({
    songs: [] as LocalSong[],
    copyLocalAudio: vi.fn(async () => ({ copied: true, ref: 'local-copy' })),
    deleteImportedAudio: vi.fn(async () => ({ deleted: [], failed: [] })),
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: () => 'android',
        isNativePlatform: () => true,
        isPluginAvailable: () => true,
    },
    registerPlugin: () => ({
        copyLocalAudio: state.copyLocalAudio,
        deleteImportedAudio: state.deleteImportedAudio,
    }),
}));

vi.mock('@/services/db', () => ({
    getLocalSongs: vi.fn(async () => state.songs.slice()),
    getLocalSong: vi.fn(async (id: string) => state.songs.find(song => song.id === id)),
    replaceLocalAudioReference: vi.fn(async (id: string, previousRef: string, nextRef: string) => {
        const index = state.songs.findIndex(song => song.id === id);
        if (index < 0) return undefined;
        const current = state.songs[index];
        if (current.nativeAudioRef !== previousRef) return current;
        state.songs[index] = { ...current, nativeAudioRef: nextRef };
        return state.songs[index];
    }),
    saveLocalSongs: vi.fn(async (songs: LocalSong[]) => {
        songs.forEach(song => {
            const index = state.songs.findIndex(existing => existing.id === song.id);
            if (index === -1) state.songs.push(song);
            else state.songs[index] = song;
        });
    }),
}));

vi.mock('@/utils/localMetadataWorkerClient', () => ({
    parseEmbeddedMetadataAsync: vi.fn(async () => null),
    parseDocumentMetadataAsync: vi.fn(async () => null),
}));

vi.mock('@/nativeBridge/api/libraryTrace.js', () => ({
    noteLibraryStep: vi.fn(),
}));

const existingSong = (overrides: Partial<LocalSong> = {}): LocalSong => ({
    id: 'android-imported-imported-a',
    fileName: 'song.mp3',
    filePath: 'Android/Imported/imported-a',
    nativeAudioRef: 'imported-a',
    duration: 100,
    fileSize: 1234,
    fileLastModified: 1_700_000_000_000,
    mimeType: 'audio/mpeg',
    addedAt: 1_700_000_000_000,
    title: 'Song',
    titleOrigin: 'import',
    importedMetadata: {
        title: 'Song',
        titleSource: 'embedded',
        artistNames: [],
        albumName: '',
    },
    folderName: 'Android 文件导入',
    hasManualLyricSelection: false,
    noAutoMatch: false,
    ...overrides,
});

const track = (id: string, fileName: string, fileSize?: number) => ({
    id,
    fileName,
    fileSize,
    url: `http://127.0.0.1:1/audio/${id}`,
});

describe('importExternalAudioTracks', () => {
    beforeEach(() => {
        state.songs = [];
        state.copyLocalAudio.mockClear();
        state.deleteImportedAudio.mockClear();
        vi.mocked(parseDocumentMetadataAsync).mockClear();
        vi.mocked(saveLocalSongs).mockClear();
        vi.stubGlobal('fetch', vi.fn(async () => ({
            blob: async () => new Blob([new Uint8Array(16)]),
        })));
    });

    it('returns the new records in both fresh and resolved on a first import', async () => {
        const result = await importExternalAudioTracks([track('imported-a', 'song.mp3', 1234)]);

        expect(result.fresh).toHaveLength(1);
        expect(result.resolved).toHaveLength(1);
        expect(result.fresh[0].id).toBe(result.resolved[0].id);
        expect(result.fresh[0].nativeAudioRef).toBe('imported-a');
    });

    it('persists document references without merging distinct folders into an old private copy', async () => {
        state.songs = [existingSong({ nativeAudioRef: 'local-1' })];
        const inputs = [track('document-a', 'song.mp3', 1234), track('document-b', 'song.mp3', 1234)];
        const first = await importExternalAudioTracks(inputs);
        expect(first.fresh.map(song => song.nativeAudioRef)).toEqual(['document-a', 'document-b']);
        const again = await importExternalAudioTracks(inputs);
        expect(again.fresh).toHaveLength(0);
        expect(again.resolved.map(song => song.id)).toEqual(first.resolved.map(song => song.id));
    });

    it('never materializes or deletes a referenced folder document', async () => {
        expect(await copyAndroidLocalAudio('document-a', 'song.flac', 1234)).toBeNull();
        expect(await deleteAndroidImportedAudio(['document-a'])).toEqual({ deleted: [], failed: [] });
        expect(state.copyLocalAudio).not.toHaveBeenCalled();
        expect(state.deleteImportedAudio).not.toHaveBeenCalled();
    });

    it('does not fetch whole document audio, including when range metadata fails or the folder is reimported', async () => {
        const input = track('document-a', 'song.flac', 512 * 1024 * 1024);
        vi.mocked(parseDocumentMetadataAsync).mockResolvedValue(null);
        await importExternalAudioTracks([input]);
        await importExternalAudioTracks([input]);
        expect(parseDocumentMetadataAsync).toHaveBeenCalledOnce();
        expect(fetch).not.toHaveBeenCalled();
        expect(state.songs).toHaveLength(1);
    });

    it('persists small batches before parsing the rest of a large document folder', async () => {
        const inputs = Array.from({ length: 61 }, (_, i) => track(`document-${i}`, `${i}.flac`, 10_000_000));
        let parsed = 0;
        vi.mocked(parseDocumentMetadataAsync).mockImplementation(async () => {
            parsed++;
            expect(parsed - state.songs.length).toBeLessThanOrEqual(25);
            return null;
        });
        const result = await importExternalAudioTracks(inputs);
        expect(result.fresh).toHaveLength(61);
        expect(state.songs).toHaveLength(61);
        expect(saveLocalSongs).toHaveBeenCalledTimes(3);
        expect(fetch).not.toHaveBeenCalled();
        vi.mocked(parseDocumentMetadataAsync).mockResolvedValue(null);
    });

    it('reuses the actual scanned file identity and retains its playlist id and manual lyrics', async () => {
        const original = existingSong({
            id: 'android-media-41', nativeAudioRef: '41',
            title: 'My edited title', hasManualLyricSelection: true,
        });
        state.songs = [original];
        const result = await importExternalAudioTracks([
            { ...track('document-a', 'song.mp3', 1234), sourceRefs: ['file-/storage/emulated/0/Music/song.mp3', '41'] },
            { ...track('document-b', 'song.mp3', 1234), sourceRefs: ['42'] },
        ]);
        expect(result.fresh.map(song => song.nativeAudioRef)).toEqual(['document-b']);
        expect(result.resolved[0]).toMatchObject({
            id: 'android-media-41', nativeAudioRef: 'document-a',
            title: 'My edited title', hasManualLyricSelection: true,
        });
        expect(state.songs).toHaveLength(2);
        expect(state.songs.find(song => song.id === original.id)?.nativeAudioRef).toBe('document-a');
    });

    it('keeps edits made while earlier document metadata is still being parsed', async () => {
        const original = existingSong({ id: 'android-media-41', nativeAudioRef: '41' });
        state.songs = [original];
        let resume!: () => void;
        const paused = new Promise<null>(resolve => { resume = () => resolve(null); });
        vi.mocked(parseDocumentMetadataAsync).mockReturnValueOnce(paused);
        const importing = importExternalAudioTracks([
            track('document-new', 'new.flac', 9999),
            { ...track('document-old', 'song.mp3', 1234), sourceRefs: ['41'] },
        ]);
        await vi.waitFor(() => expect(parseDocumentMetadataAsync).toHaveBeenCalled());
        state.songs[0] = { ...original, title: 'Edited during import', hasManualLyricSelection: true };
        resume();
        const result = await importing;
        expect(state.songs.find(song => song.id === original.id)).toMatchObject({
            title: 'Edited during import', hasManualLyricSelection: true, nativeAudioRef: 'document-old',
        });
        expect(result.resolved.find(song => song.id === original.id)?.title).toBe('Edited during import');
    });

    it('still resolves the record already sitting in the library, so the playlist gets it', async () => {
        state.songs = [existingSong()];

        const result = await importExternalAudioTracks([track('imported-a', 'song.mp3', 1234)]);

        // 已经在库里：一首都不该再写进去。
        expect(result.fresh).toHaveLength(0);
        // 但「加到歌单」要用的那份必须还在，而且是库里那条（id 一致），不是新造的。
        expect(result.resolved).toHaveLength(1);
        expect(result.resolved[0].id).toBe('android-imported-imported-a');
    });

    it('matches an already-imported copy by file name and size when the ref differs', async () => {
        state.songs = [existingSong({ nativeAudioRef: 'imported-other' })];

        // 同一个文件被原生算成了另一个 ref（大小那趟没读出来时就会这样）。
        const result = await importExternalAudioTracks([track('imported-a', 'song.mp3', 1234)]);

        expect(result.fresh).toHaveLength(0);
        expect(result.resolved[0].nativeAudioRef).toBe('imported-other');
    });

    it('keeps genuinely new files in fresh', async () => {
        state.songs = [existingSong()];

        const result = await importExternalAudioTracks([
            track('imported-a', 'song.mp3', 1234),
            track('imported-b', 'other.mp3', 4321),
        ]);

        expect(result.fresh.map(song => song.nativeAudioRef)).toEqual(['imported-b']);
        expect(result.resolved).toHaveLength(2);
    });
});

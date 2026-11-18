import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalSong } from '../../../src/types';
import { appDatabase } from '../../../src/services/appDatabase';
import { replaceLocalAudioReference } from '../../../src/services/repositories/localSongRepository';

// Replacing the playback pointer must never replace current lyrics, covers, titles, or a newer pointer.

const song: LocalSong = {
    id: 'scanned-song', fileName: 'song.flac', filePath: 'Android/MediaStore/41',
    folderName: 'Android 本地音乐', duration: 10, addedAt: 1, title: 'Original', nativeAudioRef: '41',
    fileSize: 1234, mimeType: 'audio/flac', titleOrigin: 'import',
    importedMetadata: { title: 'Original', titleSource: 'embedded', artistNames: [], albumName: '' },
};

describe('replaceLocalAudioReference', () => {
    beforeEach(async () => {
        await appDatabase.delete();
        await appDatabase.open();
    });
    afterEach(async () => { await appDatabase.delete(); });

    it('patches only the reference on the current row', async () => {
        const edited = { ...song, title: 'New title', hasManualLyricSelection: true, localCoverAssetId: 'sha256:cover' };
        await appDatabase.local_music.put(edited);
        const result = await replaceLocalAudioReference(song.id, '41', 'document-new');
        expect(result).toEqual({ ...edited, nativeAudioRef: 'document-new' });
        expect(await appDatabase.local_music.get(song.id)).toEqual(result);
    });

    it('does not replace a newer audio reference with a stale import result', async () => {
        await appDatabase.local_music.put({ ...song, nativeAudioRef: 'document-newer' });
        await replaceLocalAudioReference(song.id, '41', 'document-stale');
        expect((await appDatabase.local_music.get(song.id))?.nativeAudioRef).toBe('document-newer');
    });

    it('does not recreate a record deleted during the import', async () => {
        expect(await replaceLocalAudioReference(song.id, '41', 'document-new')).toBeUndefined();
        expect(await appDatabase.local_music.count()).toBe(0);
    });
});

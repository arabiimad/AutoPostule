import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centerCropRect, photoFileError, PHOTO_MAX_INPUT_BYTES } from '../src/utils/photo.ts';

test('photo : recadrage carré centré', () => {
  assert.deepEqual(centerCropRect(800, 600), { sx: 100, sy: 0, size: 600 });
  assert.deepEqual(centerCropRect(600, 900), { sx: 0, sy: 150, size: 600 });
  assert.deepEqual(centerCropRect(500, 500), { sx: 0, sy: 0, size: 500 });
});

test('photo : formats et poids acceptés', () => {
  assert.equal(photoFileError({ type: 'image/jpeg', size: 200_000 }), null);
  assert.equal(photoFileError({ type: 'image/png', size: 200_000 }), null);
  assert.equal(photoFileError({ type: 'image/webp', size: 200_000 }), null);
  assert.match(photoFileError({ type: 'image/gif', size: 1000 }) || '', /Format non pris en charge/);
  assert.match(photoFileError({ type: 'application/pdf', size: 1000 }) || '', /Format non pris en charge/);
  assert.match(photoFileError({ type: 'image/jpeg', size: PHOTO_MAX_INPUT_BYTES + 1 }) || '', /trop lourde/);
});

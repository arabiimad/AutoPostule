import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createZip, crc32, dataUrlBytes } from '../src/utils/zip.ts';

test('CRC-32 standard', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('archive lisible par un outil standard, contenus et noms accentués intacts', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const zip = createZip([{ name: 'cv.tex', data: '\\documentclass{article} é' }, { name: 'lettre de motivation.txt', data: 'Madame, Monsieur' }, { name: 'photo.jpg', data: jpeg }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
  const file = path.join(dir, 'projet.zip');
  fs.writeFileSync(file, zip);
  // Python (zipfile) est présent sur les machines de CI et de développement
  const out = execFileSync('python3', ['-c', `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print('|'.join(n+':'+str(len(z.read(n))) for n in z.namelist())); print(z.read('cv.tex').decode())`, file]).toString();
  assert.match(out, /cv\.tex:26\|lettre de motivation\.txt:16\|photo\.jpg:7/);
  assert.match(out, /documentclass\{article\} é/);
});

test('photo en data URL décodée', () => {
  assert.deepEqual([...dataUrlBytes('data:image/jpeg;base64,/9j/4A==')!], [0xff, 0xd8, 0xff, 0xe0]);
  assert.equal(dataUrlBytes('https://x/photo.jpg'), null);
});

/**
 * Photo de CV : recadrage carré centré et compression JPEG dans le navigateur,
 * pour rester légère (stockage du profil, envoi au serveur à la compilation).
 */
export const PHOTO_SIZE = 480;
export const PHOTO_MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const PHOTO_ACCEPTED = /^image\/(jpeg|png|webp)$/;

/** Plus grand carré centré dans une image w × h. */
export function centerCropRect(w: number, h: number): { sx: number; sy: number; size: number } {
  const size = Math.min(w, h);
  return { sx: Math.round((w - size) / 2), sy: Math.round((h - size) / 2), size };
}

/** Message d'erreur lisible, ou null si le fichier est accepté. */
export function photoFileError(file: { type: string; size: number }): string | null {
  if (!PHOTO_ACCEPTED.test(file.type)) return 'Format non pris en charge : choisissez une image JPEG, PNG ou WebP.';
  if (file.size > PHOTO_MAX_INPUT_BYTES) return 'Image trop lourde (10 Mo maximum).';
  return null;
}

/** Fichier image → data URL JPEG carrée de PHOTO_SIZE pixels. */
export async function squareJpegPhoto(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const { sx, sy, size } = centerCropRect(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = PHOTO_SIZE;
    canvas.height = PHOTO_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    // Fond blanc : une image PNG transparente ne devient pas noire en JPEG
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, PHOTO_SIZE, PHOTO_SIZE);
    ctx.drawImage(bitmap, sx, sy, size, size, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    bitmap.close();
  }
}

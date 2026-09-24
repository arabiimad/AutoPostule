/**
 * Extraction du texte d'un document Word (.docx) sans dépendance :
 * un .docx est une archive ZIP ; le texte se trouve dans word/document.xml.
 */
import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/** Lit une entrée d'une archive ZIP (méthodes « stored » et « deflate »). */
export function readZipEntry(zip: Buffer, name: string): Buffer | null {
  // Fin du répertoire central : dans les 64 derniers Ko
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entries = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);

  for (let n = 0; n < entries && p + 46 <= zip.length; n++) {
    if (zip.readUInt32LE(p) !== CEN_SIG) return null;
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const entryName = zip.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (entryName !== name) continue;

    if (zip.readUInt32LE(localOffset) !== LOC_SIG) return null;
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const data = zip.subarray(start, start + compSize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return inflateRawSync(data, { maxOutputLength: 20 * 1024 * 1024 });
    return null;
  }
  return null;
}

const decodeEntities = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");

/** Texte brut d'un .docx : paragraphes, retours à la ligne, tabulations et puces conservés. */
export function extractTextFromDocx(buffer: Buffer): string {
  const xml = readZipEntry(buffer, "word/document.xml");
  if (!xml) throw new Error("Document Word illisible");
  const body = xml.toString("utf8");
  return decodeEntities(
    body
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:(br|cr)\b[^>]*\/>/g, "\n")
      .replace(/<w:numPr>/g, "• ")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

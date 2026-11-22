import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Where confirmed waste photos go: the photos volume (ADR 0010). */
export type PhotoStore = {
  /** Writes the photo and returns its path relative to the volume, e.g. `<outlet>/<guess>.jpg`. */
  save(relativePath: string, data: Buffer): Promise<string>;
};

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};

export function photoPath(outletId: string, guessId: string, mediaType: string): string {
  return `${outletId}/${guessId}.${EXTENSIONS[mediaType] ?? "jpg"}`;
}

/** A photo store on disk. Fails fast if the directory is missing or not writable. */
export async function createPhotoStore(dir: string | undefined): Promise<PhotoStore> {
  if (!dir) throw new Error("PHOTOS_DIR is not set");
  await access(dir, constants.W_OK).catch(() => {
    throw new Error(`PHOTOS_DIR ${dir} does not exist or is not writable`);
  });
  return {
    async save(relativePath, data) {
      const file = join(dir, relativePath);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, data, { flag: "wx" });
      return relativePath;
    },
  };
}

import { isUtf8 } from "node:buffer";

/** Why a blob is not text: it holds a NUL byte, as binary files do, or it is not valid UTF-8. */
export type NonTextBlobReason = "binary" | "invalidEncoding";

const NUL_BYTE = 0;

/** Why `content` cannot be read as text; null when it is free of NUL bytes and valid UTF-8. */
export function nonTextBlobReason(content: Buffer): NonTextBlobReason | null {
  if (content.includes(NUL_BYTE)) {
    return "binary";
  }
  if (!isUtf8(content)) {
    return "invalidEncoding";
  }
  return null;
}

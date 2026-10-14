import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Node's ESM loader realpaths the entry module's URL, but process.argv[1] keeps the caller's
// spelling. Comparing them raw makes a symlinked launch path (macOS tmpdir /var -> /private/var,
// symlinked checkouts) skip main() and exit 0 silently, so both sides are realpathed.
export function isDirectRun(importMetaUrl, entry = process.argv[1]) {
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(path.resolve(entry)) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

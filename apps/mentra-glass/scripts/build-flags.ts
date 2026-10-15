/**
 * Build-time trace gate (used by build.ts). `pack`/`release` build with
 * NODE_ENV=production; a trace flag left in the shell or .env must not ship
 * transcripts to the console there, so the flag is honored only outside
 * production and only for the exact value "1".
 */
export function traceDefine(env: {NODE_ENV?: string; MENTRA_PUBLIC_TRACE?: string}): string {
  const traceOn = env.NODE_ENV !== "production" && env.MENTRA_PUBLIC_TRACE === "1"
  return JSON.stringify(traceOn ? "1" : "")
}

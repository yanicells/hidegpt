/** Maps an attached image (a local path or a URL) to a source an <img> can load. */
export function imageSrc(ref: string): string {
  return /^(data:|https?:|docs:)/.test(ref) ? ref : `docs://local/${encodeURIComponent(ref)}`
}

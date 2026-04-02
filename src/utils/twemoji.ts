/**
 * Returns the Twemoji CDN URL for a given emoji codepoint string.
 * The codepoint format matches the `id` field in src/assets/emoji-data.json
 * (e.g., "1f600", "1f1e6-1f1fa", "2764-fe0f-200d-1f525").
 *
 * Twemoji is open source (CC-BY 4.0) by Twitter/X.
 * Served via jsDelivr CDN (allowed in tauri.conf.json img-src CSP).
 */
export function twemojiUrl(codepoint: string): string {
  return `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/${codepoint}.svg`
}

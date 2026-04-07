/**
 * Converts a Twemoji codepoint string to a Unicode emoji character.
 * The codepoint format matches the `id` field in src/assets/emoji-data.json
 * (e.g., "1f600", "1f1e6-1f1fa", "2764-fe0f-200d-1f525").
 *
 * Used to render emoji as native text instead of loading remote images,
 * which avoids CDN/tracking-prevention issues in Tauri's WebView.
 */
export function codepointToChar(codepoint: string): string {
  return codepoint.split('-').map(cp => String.fromCodePoint(parseInt(cp, 16))).join('')
}

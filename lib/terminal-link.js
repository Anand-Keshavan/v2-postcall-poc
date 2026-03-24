/**
 * OSC 8 terminal hyperlinks
 *
 * Wraps a URL in the OSC 8 escape sequence so it becomes clickable
 * in supporting terminals (iTerm2, VS Code terminal, Terminal.app on macOS 14+,
 * Windows Terminal, etc.)
 *
 * cmd+click (macOS) / ctrl+click (Windows/Linux) opens the URL.
 * Right-click → "Open Link" also works in iTerm2 and VS Code.
 *
 * Falls back to plain text when stdout is not a TTY (piped output, CI, etc.)
 *
 * @param {string} url   - The URL to make clickable
 * @param {string} [text] - Display text (defaults to the URL itself)
 * @returns {string}
 */
function link(url, text) {
  if (!url || typeof url !== 'string') return text || url || '';
  const display = text || url;
  if (!process.stdout.isTTY) return display;
  return `\x1b]8;;${url}\x1b\\${display}\x1b]8;;\x1b\\`;
}

module.exports = { link };

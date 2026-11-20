/** Divide um stream de texto em linhas, preservando o restante entre chunks. */
export function createLineSplitter(onLine) {
  let rest = '';
  return {
    push(chunk) {
      rest += chunk.toString('utf8');
      const parts = rest.split(/\r?\n/);
      rest = parts.pop() ?? '';
      for (const line of parts) onLine(line);
    },
    flush() {
      if (rest) onLine(rest);
      rest = '';
    },
  };
}

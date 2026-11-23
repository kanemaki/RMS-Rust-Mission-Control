/**
 * Cálculos de horário da operação automática.
 * Funções puras: recebem `from` para os testes não dependerem do relógio.
 */

/** Próxima ocorrência diária de HH:mm (hoje se ainda não passou, senão amanhã). */
export function nextDailyAt(time, from = Date.now()) {
  const [hour, minute] = String(time).split(':').map(Number);
  const current = new Date(from);
  let candidate = new Date(current.getFullYear(), current.getMonth(), current.getDate(), hour, minute, 0, 0);
  if (candidate.getTime() <= from) {
    candidate = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1, hour, minute, 0, 0);
  }
  return candidate.getTime();
}

/** Próxima ocorrência de um intervalo fixo em minutos, contada a partir de `from`. */
export function nextIntervalAt(intervalMinutes, from = Date.now()) {
  const minutes = Number(intervalMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('intervalMinutes inválido.');
  return from + Math.round(minutes * 60000);
}

/** Normaliza o texto de um anúncio: uma linha só, sem espaços sobrando, tamanho limitado. */
export function sanitizeAnnouncement(text, maxLength = 200) {
  return String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

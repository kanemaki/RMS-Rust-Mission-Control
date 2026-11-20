import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const POWERSHELL_TIMEOUT_MS = 5000;

// Devolve { cpu, mem } do processo (CPU em segundos acumulados, mem em bytes)
// ou null quando o processo não existe / a consulta falha.
export function sampleProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
  if (process.platform === 'win32') return sampleWindows(pid);
  return Promise.resolve(sampleProc(pid));
}

function sampleWindows(pid) {
  const script = `$p = Get-Process -Id ${pid} -ErrorAction Stop; if ($p) { '{0};{1}' -f $p.TotalProcessorTime.Ticks, $p.WorkingSet64 }`;
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const [ticks, bytes] = String(stdout).trim().split(';').map(Number);
        if (!Number.isFinite(ticks) || !Number.isFinite(bytes)) return resolve(null);
        resolve({ cpu: ticks / 10_000_000, mem: bytes });
      },
    );
  });
}

function sampleProc(pid) {
  try {
    const statFile = `/proc/${pid}/stat`;
    if (!existsSync(statFile)) return null;
    const stat = readFileSync(statFile, 'utf8');
    const end = stat.lastIndexOf(')');
    const fields = stat.slice(end + 2).split(' ');
    // Após o estado (campo 3), utime e stime são os campos 12 e 13 (índices 11 e 12).
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    const statm = readFileSync(`/proc/${pid}/statm`, 'utf8').trim().split(' ');
    const residentPages = Number(statm[1]);
    if (!Number.isFinite(utime) || !Number.isFinite(stime) || !Number.isFinite(residentPages)) return null;
    const clockTicks = 100; // CLK_TCK padrão em Linux
    return {
      cpu: (utime + stime) / clockTicks,
      mem: residentPages * 4096,
    };
  } catch {
    return null;
  }
}

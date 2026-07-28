/**
 * Terminal styling, honouring NO_COLOR and non-TTY streams. Every style is a
 * plain string→string function so call sites stay readable either way.
 */

export interface Style {
  red: (s: string) => string;
  yellow: (s: string) => string;
  green: (s: string) => string;
  cyan: (s: string) => string;
  magenta: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
  enabled: boolean;
}

const plain = (s: string) => s;

export function styleFor(stream: { isTTY?: boolean }): Style {
  const force = process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0';
  const enabled = (stream.isTTY === true || force) &&
    process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
  if (!enabled) {
    return { red: plain, yellow: plain, green: plain, cyan: plain, magenta: plain, dim: plain, bold: plain, enabled };
  }
  const wrap = (open: number, close: number) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;
  return {
    red: wrap(31, 39),
    yellow: wrap(33, 39),
    green: wrap(32, 39),
    cyan: wrap(36, 39),
    magenta: wrap(35, 39),
    dim: wrap(2, 22),
    bold: wrap(1, 22),
    enabled,
  };
}

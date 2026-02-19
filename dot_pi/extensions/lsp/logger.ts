// Simple logger stub
export const logger = {
  debug: (...args: any[]) => {},
  info: (...args: any[]) => console.log("[LSP]", ...args),
  warn: (...args: any[]) => console.warn("[LSP WARN]", ...args),
  error: (...args: any[]) => console.error("[LSP ERROR]", ...args),
};

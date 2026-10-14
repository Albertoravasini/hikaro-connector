declare module "qrcode-terminal" {
  interface Options {
    small?: boolean;
  }
  export function generate(text: string, opts?: Options, cb?: (qr: string) => void): void;
  export function setErrorLevel(level: "L" | "M" | "Q" | "H"): void;
  const _default: { generate: typeof generate; setErrorLevel: typeof setErrorLevel };
  export default _default;
}

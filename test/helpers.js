import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

export function loadScript(file, globals = {}) {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    URL,
    Blob,
    Response,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ...globals
  });
  vm.runInContext(fs.readFileSync(path.resolve(file), "utf8"), context, { filename: path.resolve(file) });
  return context;
}

export function sentence(text, order, section = "results") {
  return { text, order, section, pageIndex: 0, rects: [[0, 0, 10, 10]] };
}

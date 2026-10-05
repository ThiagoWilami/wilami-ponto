// Build de produção (rodado pela Vercel): gera dist/index.html já compilado.
//  - JSX → JavaScript pronto (o navegador não precisa mais baixar e rodar o Babel)
//  - Tailwind → CSS estático só com as classes usadas (sem o gerador ao vivo do CDN)
// O index.html da raiz continua funcionando sozinho (abre direto no navegador, sem build).
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const Babel = require("@babel/standalone");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT = path.join(ROOT, "dist");
const TMP = path.join(ROOT, ".build-tmp");

let html = readFileSync(path.join(ROOT, "index.html"), "utf8");
const trocar = (de, para, rotulo) => {
  if (!html.includes(de)) throw new Error("build: trecho não encontrado — " + rotulo);
  html = html.replace(de, () => para);
};

// 1) JSX → JS
const abre = '<script type="text/babel" data-presets="react">';
const ini = html.indexOf(abre);
const fim = html.indexOf("</script>", ini);
if (ini < 0 || fim < 0) throw new Error("build: bloco text/babel não encontrado");
const jsx = html.slice(ini + abre.length, fim);
const js = Babel.transform(jsx, { presets: ["react"], compact: false, comments: false }).code;
if (js.includes("</script")) throw new Error("build: o código compilado contém </script>");
html = html.slice(0, ini) + "<script>\n" + js + "\n" + html.slice(fim);
trocar('<script src="https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.5/babel.min.js"></script>\n', "", "script do Babel");

// 2) Tailwind → CSS estático (mesmo tema do tailwind.config da página)
const cfg = /<script>\s*tailwind\.config = (\{[\s\S]*?\n  \})\n<\/script>\n/.exec(html);
if (!cfg) throw new Error("build: tailwind.config não encontrado");
rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true });
writeFileSync(path.join(TMP, "tailwind.config.cjs"), `module.exports={content:[${JSON.stringify(path.join(ROOT, "index.html"))}],...${cfg[1]}};`);
writeFileSync(path.join(TMP, "in.css"), "@tailwind base;@tailwind components;@tailwind utilities;");
execFileSync(process.execPath, [require.resolve("tailwindcss/lib/cli.js"), "-c", path.join(TMP, "tailwind.config.cjs"), "-i", path.join(TMP, "in.css"), "-o", path.join(TMP, "out.css"), "--minify"], { stdio: "inherit" });
const css = readFileSync(path.join(TMP, "out.css"), "utf8");
trocar(cfg[0], "", "bloco tailwind.config");
trocar('<script src="https://cdn.tailwindcss.com"></script>\n', "<style>" + css + "</style>\n", "script do Tailwind CDN");
rmSync(TMP, { recursive: true, force: true });

mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, "index.html"), html);
console.log(`build ok: dist/index.html (${(html.length / 1024).toFixed(0)} KB, CSS ${(css.length / 1024).toFixed(0)} KB)`);

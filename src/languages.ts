import { StreamLanguage } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

export interface LangDef {
  label: string;
  exts: string[];
  /** 语法包全部静态导入会让主包体积翻倍，所以命中后缀时才动态 import 对应模块 */
  load: () => Promise<Extension | null>;
}

type StreamParser = Parameters<typeof StreamLanguage.define>[0];

/** 同一条语言只加载一次，连 Promise 一起缓存，重复打开同后缀不会二次取模块 */
export function lazy(get: () => Promise<Extension | null>): () => Promise<Extension | null> {
  let cache: Promise<Extension | null> | undefined;
  // 失败不永久缓存：清掉被拒的 Promise，下次打开可重试，避免一次加载失败就永远无高亮
  return () => (cache ??= get().catch((e) => { cache = undefined; throw e; }));
}

/** legacy-modes 的解析器都是具名导出，统一包成 StreamLanguage */
const stream = (get: () => Promise<StreamParser>) => lazy(async () => StreamLanguage.define(await get()));

export const LANGUAGES: LangDef[] = [
  { label: "JavaScript", exts: ["js", "mjs", "cjs", "jsx"], load: lazy(async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true })) },
  { label: "TypeScript", exts: ["ts", "mts", "cts", "tsx"], load: lazy(async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true })) },
  { label: "JSON", exts: ["json", "jsonc", "jsonl", "geojson", "topojson"], load: lazy(async () => (await import("@codemirror/lang-json")).json()) },
  { label: "HTML", exts: ["html", "htm", "vue", "svelte", "xht", "xhtml"], load: lazy(async () => (await import("@codemirror/lang-html")).html()) },
  { label: "CSS", exts: ["css", "scss", "less"], load: lazy(async () => (await import("@codemirror/lang-css")).css()) },
  { label: "Sass", exts: ["sass"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/sass")).sass) },
  { label: "Stylus", exts: ["styl"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/stylus")).stylus) },
  { label: "Markdown", exts: ["md", "markdown", "mdown", "mkd"], load: lazy(async () => (await import("@codemirror/lang-markdown")).markdown()) },
  { label: "Python", exts: ["py", "pyi", "pyw"], load: lazy(async () => (await import("@codemirror/lang-python")).python()) },
  { label: "Java", exts: ["java"], load: lazy(async () => (await import("@codemirror/lang-java")).java()) },
  { label: "Kotlin", exts: ["kt", "kts"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/clike")).kotlin) },
  { label: "Scala", exts: ["scala", "sbt"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/clike")).scala) },
  { label: "C#", exts: ["cs", "csx"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/clike")).csharp) },
  { label: "Dart", exts: ["dart"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/clike")).dart) },
  { label: "Objective-C", exts: ["m", "mm", "objc"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/clike")).objectiveC) },
  { label: "Swift", exts: ["swift"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/swift")).swift) },
  { label: "C", exts: ["c", "h"], load: lazy(async () => (await import("@codemirror/lang-cpp")).cpp()) },
  { label: "C++", exts: ["cpp", "cc", "cxx", "cp", "hpp", "hh", "hxx", "inl", "ipp", "tpp"], load: lazy(async () => (await import("@codemirror/lang-cpp")).cpp()) },
  { label: "Rust", exts: ["rs"], load: lazy(async () => (await import("@codemirror/lang-rust")).rust()) },
  { label: "Go", exts: ["go"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/go")).go) },
  { label: "Ruby", exts: ["rb", "rake", "gemspec"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/ruby")).ruby) },
  { label: "Crystal", exts: ["cr"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/crystal")).crystal) },
  { label: "PHP", exts: ["php", "php3", "php4", "php5", "phtml"], load: lazy(async () => (await import("@codemirror/lang-php")).php()) },
  { label: "SQL", exts: ["sql", "ddl", "dml"], load: lazy(async () => (await import("@codemirror/lang-sql")).sql()) },
  { label: "XML", exts: ["xml", "xsl", "xsd", "svg", "plist", "pom", "wsdl"], load: lazy(async () => (await import("@codemirror/lang-xml")).xml()) },
  { label: "YAML", exts: ["yaml", "yml"], load: lazy(async () => (await import("@codemirror/lang-yaml")).yaml()) },
  { label: "TOML", exts: ["toml"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/toml")).toml) },
  { label: "INI", exts: ["ini", "conf", "cfg", "properties", "env"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/properties")).properties) },
  { label: "Shell", exts: ["sh", "bash", "zsh", "fish", "ksh", "bashrc", "zshrc"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/shell")).shell) },
  { label: "PowerShell", exts: ["ps1", "psm1", "psd1"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/powershell")).powerShell) },
  { label: "CMake", exts: ["cmake"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/cmake")).cmake) },
  { label: "Dockerfile", exts: ["dockerfile"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile) },
  { label: "Diff", exts: ["diff", "patch", "rej"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/diff")).diff) },
  { label: "Lua", exts: ["lua"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/lua")).lua) },
  { label: "Perl", exts: ["pl", "pm", "pod"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/perl")).perl) },
  { label: "R", exts: ["r", "rd"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/r")).r) },
  { label: "Julia", exts: ["jl"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/julia")).julia) },
  { label: "Haskell", exts: ["hs", "lhs"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/haskell")).haskell) },
  { label: "Erlang", exts: ["erl", "hrl", "escript"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/erlang")).erlang) },
  { label: "Clojure", exts: ["clj", "cljs", "cljc", "edn"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/clojure")).clojure) },
  { label: "Common Lisp", exts: ["lisp", "lsp", "el"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/commonlisp")).commonLisp) },
  { label: "Scheme", exts: ["scm", "ss", "rkt"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/scheme")).scheme) },
  { label: "Groovy", exts: ["groovy", "gvy", "gy", "gradle"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/groovy")).groovy) },
  { label: "Fortran", exts: ["f", "f77", "f90", "f95", "f03", "for"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/fortran")).fortran) },
  { label: "Pascal", exts: ["pas", "dpr", "dpk", "inc"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/pascal")).pascal) },
  { label: "Verilog", exts: ["v", "sv", "svh", "vh"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/verilog")).verilog) },
  { label: "Protocol Buffers", exts: ["proto"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/protobuf")).protobuf) },
  { label: "Tcl", exts: ["tcl", "tk"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/tcl")).tcl) },
  { label: "CoffeeScript", exts: ["coffee"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/coffeescript")).coffeeScript) },
  { label: "VB", exts: ["vb", "vbs", "bas"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/vb")).vb) },
  { label: "HTTP", exts: ["http", "rest"], load: stream(async () => (await import("@codemirror/legacy-modes/mode/http")).http) }
];

export const PLAIN: LangDef = { label: "纯文本", exts: [], load: lazy(async () => null) };

/** 无扩展名或扩展名不足以判断的文件名 */
const BASENAME_LANGS: Record<string, string> = {
  dockerfile: "Dockerfile",
  "cmakelists.txt": "CMake",
  jenkinsfile: "Groovy",
  gemfile: "Ruby",
  brewfile: "Ruby",
  vagrantfile: "Ruby"
};

export function languageByLabel(label: string): LangDef {
  return LANGUAGES.find((l) => l.label === label) ?? PLAIN;
}

export function languageForFile(name: string): LangDef {
  const basename = name.toLowerCase();
  const special = BASENAME_LANGS[basename];
  if (special) return languageByLabel(special);
  const ext = basename.includes(".") ? basename.split(".").pop()! : "";
  return LANGUAGES.find((l) => l.exts.includes(ext)) ?? PLAIN;
}

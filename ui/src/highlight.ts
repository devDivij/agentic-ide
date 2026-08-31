/**
 * Syntax highlighting, in one file and with no dependency.
 *
 * A highlighter is the kind of thing you reach for a library for, and we
 * deliberately did not: `ui/package.json` is react and react-dom, nothing
 * else, and a tokenizer small enough to read in one sitting keeps it that way.
 * What is here is not a parser and does not pretend to be — it is a lexer good
 * enough to read code by, which is all a review surface needs.
 *
 * The whole technique is ONE ordered alternation, scanned in a single pass:
 *
 *     comment | string | number | identifier
 *
 * Order is the entire correctness argument. At any position the earliest
 * alternative that matches wins, so `# not a comment` inside a string is part
 * of the string (the string alternative starts earlier), and the word `class`
 * inside a comment never becomes a keyword. Get the order right and the hard
 * cases stop being cases at all.
 *
 * Two deliberate constraints:
 *
 *   - The whole document is tokenized at once and only then split into lines,
 *     because a block comment or a triple-quoted string is not a line-local
 *     fact. Highlighting line by line gets those wrong by construction.
 *   - We emit token objects, never an HTML string. The caller renders them as
 *     React elements, so file contents from disk are escaped by React and a
 *     file containing `<img onerror=...>` is text, not script. There is no
 *     dangerouslySetInnerHTML anywhere in this feature, on purpose.
 */

/** A run of characters sharing one colour. `cls` of null means plain text. */
export interface Token {
  text: string;
  cls: string | null;
}

interface Grammar {
  /** The ordered alternation. Must be /g, and every branch a named group. */
  re: RegExp;
  /** Words that colour as keywords once the `id` branch has matched. */
  keywords?: Set<string>;
  /** Words that colour as types/builtins. */
  types?: Set<string>;
}

const words = (s: string): Set<string> => new Set(s.split(' '));

// --- grammars -------------------------------------------------------------

const C_KEYWORDS = words(
  'abstract as async await break case catch class const continue debugger declare default delete do ' +
  'else enum export extends finally for from func function get go if implements import in instanceof ' +
  'interface let new of package private protected public readonly return satisfies set static struct ' +
  'super switch this throw try type typeof var void while with yield impl fn pub use mod match loop ' +
  'defer chan select range nil true false null undefined');

const C_TYPES = words(
  'any bigint boolean number string symbol object never unknown Array Map Set Promise Record Partial ' +
  'Date RegExp Error JSON Math int int8 int16 int32 int64 uint float32 float64 byte rune bool str ' +
  'usize isize u8 u16 u32 u64 i8 i16 i32 i64 f32 f64 char double long short unsigned Vec Option Result');

/**
 * Strings cover "…", '…' and `…`; the escape branch is `\\[\s\S]` rather than
 * `\\.` so a backslash-newline inside a template literal does not end it.
 */
const C_LIKE: Grammar = {
  re: new RegExp(
    '(?<com>//[^\\n]*|/\\*[\\s\\S]*?\\*/)' +
    '|(?<str>"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|`(?:\\\\[\\s\\S]|[^`\\\\])*`)' +
    '|(?<num>\\b0[xXbBoO][0-9a-fA-F_]+\\b|\\b\\d[\\d_]*(?:\\.[\\d_]+)?(?:[eE][+-]?\\d+)?\\b)' +
    '|(?<id>[A-Za-z_$][\\w$]*)',
    'g'),
  keywords: C_KEYWORDS,
  types: C_TYPES,
};

const PY_KEYWORDS = words(
  'and as assert async await break class continue def del elif else except finally for from global ' +
  'if import in is lambda nonlocal not or pass raise return try while with yield match case ' +
  'True False None self cls');

const PY_TYPES = words(
  'int float str bool list dict set tuple bytes object type range len print open super Exception ' +
  'ValueError TypeError KeyError IndexError RuntimeError');

/** Triple quotes must precede single quotes, or `"""` lexes as an empty `""`. */
const PYTHON: Grammar = {
  re: new RegExp(
    '(?<com>#[^\\n]*)' +
    '|(?<str>[rbfuRBFU]{0,2}(?:"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'' +
    '|"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'))' +
    '|(?<num>\\b0[xXbBoO][0-9a-fA-F_]+\\b|\\b\\d[\\d_]*(?:\\.[\\d_]+)?(?:[eE][+-]?\\d+)?\\b)' +
    '|(?<id>[A-Za-z_]\\w*)',
    'g'),
  keywords: PY_KEYWORDS,
  types: PY_TYPES,
};

/** A string immediately before a colon is a key, so it can colour differently. */
const JSON_G: Grammar = {
  re: new RegExp(
    '(?<key>"(?:\\\\[\\s\\S]|[^"\\\\])*"(?=\\s*:))' +
    '|(?<str>"(?:\\\\[\\s\\S]|[^"\\\\])*")' +
    '|(?<num>-?\\b\\d[\\d]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)' +
    '|(?<kw>\\b(?:true|false|null)\\b)',
    'g'),
};

const CSS_G: Grammar = {
  re: new RegExp(
    '(?<com>/\\*[\\s\\S]*?\\*/)' +
    '|(?<str>"[^"\\n]*"|\'[^\'\\n]*\')' +
    '|(?<kw>@[\\w-]+)' +
    '|(?<var>--[\\w-]+)' +
    '|(?<num>#[0-9a-fA-F]{3,8}\\b|\\b\\d*\\.?\\d+(?:px|em|rem|%|vh|vw|fr|deg|ms|s)?\\b)' +
    '|(?<key>[-a-zA-Z]+(?=\\s*:))' +
    '|(?<typ>[.#][\\w-]+)',
    'g'),
};

const SHELL: Grammar = {
  re: new RegExp(
    '(?<com>#[^\\n]*)' +
    '|(?<str>"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'[^\']*\')' +
    '|(?<var>\\$\\{[^}\\n]*\\}|\\$[A-Za-z_]\\w*|\\$[0-9@*?#])' +
    '|(?<id>[A-Za-z_][\\w-]*)',
    'g'),
  keywords: words(
    'if then else elif fi for while until do done case esac function return exit local export ' +
    'readonly source set unset shift trap echo cd test in'),
};

const YAML: Grammar = {
  re: new RegExp(
    '(?<com>#[^\\n]*)' +
    '|(?<str>"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'[^\']*\')' +
    '|(?<key>^[ \\t]*(?:-[ \\t]+)?[\\w.-]+(?=[ \\t]*:))' +
    '|(?<num>\\b\\d[\\d_]*(?:\\.\\d+)?\\b)' +
    '|(?<kw>\\b(?:true|false|null|yes|no|on|off)\\b)',
    'gm'),
};

const MARKDOWN: Grammar = {
  re: new RegExp(
    '(?<kw>^#{1,6}[^\\n]*)' +
    '|(?<str>^```[\\s\\S]*?^```|`[^`\\n]+`)' +
    '|(?<typ>\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__)' +
    '|(?<var>\\[[^\\]\\n]*\\]\\([^)\\n]*\\))' +
    '|(?<com>^[ \\t]*>[^\\n]*)',
    'gm'),
};

const HTML: Grammar = {
  re: new RegExp(
    '(?<com><!--[\\s\\S]*?-->)' +
    '|(?<str>"[^"\\n]*"|\'[^\'\\n]*\')' +
    '|(?<typ></?[A-Za-z][\\w:-]*)' +
    '|(?<key>[A-Za-z-]+(?=\\s*=))',
    'g'),
};

/** Extension → grammar. Anything absent renders as plain text, never an error. */
const BY_EXTENSION: Record<string, Grammar> = {
  ts: C_LIKE, tsx: C_LIKE, js: C_LIKE, jsx: C_LIKE, mjs: C_LIKE, cjs: C_LIKE,
  java: C_LIKE, go: C_LIKE, rs: C_LIKE, c: C_LIKE, h: C_LIKE, cpp: C_LIKE,
  cc: C_LIKE, hpp: C_LIKE, cs: C_LIKE, swift: C_LIKE, kt: C_LIKE, scala: C_LIKE,
  php: C_LIKE, dart: C_LIKE,
  py: PYTHON, pyi: PYTHON,
  json: JSON_G, jsonc: JSON_G,
  css: CSS_G, scss: CSS_G, less: CSS_G,
  sh: SHELL, bash: SHELL, zsh: SHELL,
  yml: YAML, yaml: YAML, toml: YAML,
  md: MARKDOWN, markdown: MARKDOWN,
  html: HTML, htm: HTML, xml: HTML, svg: HTML, vue: HTML,
};

export function grammarFor(path: string): Grammar | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return BY_EXTENSION[ext] ?? null;
}

// --- the scanner ----------------------------------------------------------

/**
 * Beyond this many characters we stop colouring and hand back plain text.
 *
 * The viewer renders a <div> per line and highlighting adds several <span>s
 * to each, so a very large file turns into a DOM big enough to lock the panel.
 * A reader who opens a 40k-line bundle wants to see it, not wait for it —
 * plain text now beats colour eventually.
 */
const MAX_HIGHLIGHT_CHARS = 300_000;

/** Which CSS class a matched named group paints with. */
const CLASS_OF: Record<string, string> = {
  com: 'syn-com', str: 'syn-str', num: 'syn-num', kw: 'syn-kw',
  key: 'syn-key', var: 'syn-var', typ: 'syn-typ',
};

function classify(groups: Record<string, string | undefined>, g: Grammar, src: string,
                  end: number): string | null {
  for (const name of Object.keys(CLASS_OF)) {
    if (groups[name] !== undefined) return CLASS_OF[name]!;
  }
  const id = groups.id;
  if (id === undefined) return null;
  if (g.keywords?.has(id)) return 'syn-kw';
  if (g.types?.has(id)) return 'syn-typ';
  // A name followed by `(` is being called or defined. Cheap, and it is most
  // of what makes highlighted code scannable — the verbs stand out.
  let i = end;
  while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
  if (src[i] === '(') return 'syn-fn';
  // Capitalised bare words read as types in every language here.
  if (/^[A-Z]/.test(id)) return 'syn-typ';
  return null;
}

function tokenize(src: string, g: Grammar): Token[] {
  const out: Token[] = [];
  let last = 0;
  g.re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = g.re.exec(src)) !== null) {
    // A zero-width match would spin forever; step past it.
    if (m[0].length === 0) { g.re.lastIndex++; continue; }
    if (m.index > last) out.push({ text: src.slice(last, m.index), cls: null });
    out.push({
      text: m[0],
      cls: classify(m.groups ?? {}, g, src, m.index + m[0].length),
    });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ text: src.slice(last), cls: null });
  return out;
}

/** Cut tokens at newlines so each line can be rendered as its own row. */
function splitLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const tok of tokens) {
    const parts = tok.text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part !== '') lines[lines.length - 1]!.push({ text: part, cls: tok.cls });
    });
  }
  return lines;
}

/**
 * Tokenize a whole document into one token array per line.
 *
 * Always returns exactly as many entries as `src` has lines, so a caller can
 * index it alongside its own line numbering without bounds-checking.
 */
export function highlight(src: string, path: string): Token[][] {
  const grammar = grammarFor(path);
  const plain = (): Token[][] =>
    src.split('\n').map((line) => (line === '' ? [] : [{ text: line, cls: null }]));

  if (!grammar || src.length > MAX_HIGHLIGHT_CHARS) return plain();

  try {
    const lines = splitLines(tokenize(src, grammar));
    const expected = src.split('\n').length;
    // A grammar bug that loses or invents lines would silently misalign every
    // line number in the viewer. Cheaper to check than to debug.
    return lines.length === expected ? lines : plain();
  } catch {
    return plain();   // colour is a nicety; never fail the read for it
  }
}

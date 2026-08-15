/**
 * A tiny JavaScript/TypeScript lexer, plus the statement patterns that carry a
 * module specifier.
 *
 * Import rewiring must never touch a specifier-looking string that lives inside
 * another string, a template literal, a comment, or a regular expression, so the
 * source is tokenized first and only string tokens in a recognized syntactic
 * position are reported. That is the whole reason this is a lexer and not a set
 * of regular expressions.
 */

export type SpecifierKind = 'import' | 'export' | 'dynamic-import' | 'require';

export type ModuleSpecifier = {
  kind: SpecifierKind;
  /** Specifier text exactly as written between the quotes. */
  value: string;
  /** Offset of the first character inside the opening quote. */
  start: number;
  /** Offset of the closing quote. */
  end: number;
};

type TokenType = 'ident' | 'punct' | 'string' | 'number' | 'template' | 'regex';

type Token = {
  type: TokenType;
  /** Token text; for a string this is the text between the quotes. */
  value: string;
  /** Offset of the first character; for a string, the first character inside the quote. */
  start: number;
  /** Offset one past the last character; for a string, the offset of the closing quote. */
  end: number;
};

/** Keywords after which a `/` starts a regular expression rather than a division. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);

function isIdentifierStart(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x24 || // $
    code === 0x5f || // _
    code > 0x7f
  );
}

function isIdentifierPart(code: number): boolean {
  return isIdentifierStart(code) || (code >= 0x30 && code <= 0x39);
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isWhitespace(code: number): boolean {
  return (
    code === 0x20 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    code === 0x0b ||
    code === 0x0c ||
    code === 0xa0 ||
    code === 0xfeff
  );
}

/**
 * Whether a `/` at this point opens a regular expression, decided from the last
 * significant token. `}` is treated as the end of a block rather than of an
 * object literal, which is the far more common case in published sources.
 */
function regexAllowed(previous: Token | undefined): boolean {
  if (previous == null) return true;
  if (previous.type === 'ident') return REGEX_PRECEDING_KEYWORDS.has(previous.value);
  if (previous.type === 'punct') return previous.value !== ')' && previous.value !== ']';
  return false;
}

function scanLineComment(source: string, index: number): number {
  let i = index + 2;
  while (i < source.length && source.charCodeAt(i) !== 0x0a) i++;
  return i;
}

function scanBlockComment(source: string, index: number): number {
  const end = source.indexOf('*/', index + 2);
  return end === -1 ? source.length : end + 2;
}

function scanRegex(source: string, index: number): number {
  let i = index + 1;
  let inClass = false;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '\n') break;
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      i++;
      while (i < source.length && isIdentifierPart(source.charCodeAt(i))) i++;
      return i;
    }
    i++;
  }
  return i;
}

/** End offset of the quote character closing a string that starts at `index`. */
function scanStringEnd(source: string, index: number): number {
  const quote = source[index];
  let i = index + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i;
    if (ch === '\n') return i;
    i++;
  }
  return i;
}

/**
 * Split `source` into the tokens that matter for finding module specifiers.
 *
 * Template literals are tracked with a brace stack so that `${...}` holes are
 * lexed as ordinary code while the literal text around them is not.
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const braces: Array<'block' | 'template'> = [];
  let i = 0;

  /** Consume template text from `index`, returning where it stopped and why. */
  const scanTemplate = (index: number): { end: number; hole: boolean } => {
    let j = index;
    while (j < source.length) {
      const ch = source[j];
      if (ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === '`') return { end: j + 1, hole: false };
      if (ch === '$' && source[j + 1] === '{') return { end: j + 2, hole: true };
      j++;
    }
    return { end: j, hole: false };
  };

  while (i < source.length) {
    const code = source.charCodeAt(i);

    if (isWhitespace(code)) {
      i++;
      continue;
    }
    if (code === 0x2f && source[i + 1] === '/') {
      i = scanLineComment(source, i);
      continue;
    }
    if (code === 0x2f && source[i + 1] === '*') {
      i = scanBlockComment(source, i);
      continue;
    }
    if (code === 0x22 || code === 0x27) {
      const closing = scanStringEnd(source, i);
      tokens.push({
        type: 'string',
        value: source.slice(i + 1, closing),
        start: i + 1,
        end: closing,
      });
      i = closing + 1;
      continue;
    }
    if (code === 0x60) {
      const start = i;
      const scanned = scanTemplate(i + 1);
      tokens.push({ type: 'template', value: '', start, end: scanned.end });
      if (scanned.hole) braces.push('template');
      i = scanned.end;
      continue;
    }
    if (code === 0x7d && braces[braces.length - 1] === 'template') {
      braces.pop();
      const scanned = scanTemplate(i + 1);
      tokens.push({ type: 'template', value: '', start: i, end: scanned.end });
      if (scanned.hole) braces.push('template');
      i = scanned.end;
      continue;
    }
    if (code === 0x7b) {
      braces.push('block');
      tokens.push({ type: 'punct', value: '{', start: i, end: i + 1 });
      i++;
      continue;
    }
    if (code === 0x7d) {
      braces.pop();
      tokens.push({ type: 'punct', value: '}', start: i, end: i + 1 });
      i++;
      continue;
    }
    if (code === 0x2f && regexAllowed(tokens[tokens.length - 1])) {
      const end = scanRegex(source, i);
      tokens.push({ type: 'regex', value: '', start: i, end });
      i = end;
      continue;
    }
    if (isIdentifierStart(code)) {
      const start = i;
      while (i < source.length && isIdentifierPart(source.charCodeAt(i))) i++;
      tokens.push({ type: 'ident', value: source.slice(start, i), start, end: i });
      continue;
    }
    if (isDigit(code) || (code === 0x2e && isDigit(source.charCodeAt(i + 1)))) {
      const start = i;
      while (
        i < source.length &&
        (isIdentifierPart(source.charCodeAt(i)) ||
          source[i] === '.' ||
          ((source[i] === '+' || source[i] === '-') &&
            (source[i - 1] === 'e' || source[i - 1] === 'E')))
      ) {
        i++;
      }
      tokens.push({ type: 'number', value: source.slice(start, i), start, end: i });
      continue;
    }

    tokens.push({ type: 'punct', value: source[i], start: i, end: i + 1 });
    i++;
  }

  return tokens;
}

function isPunct(token: Token | undefined, value: string): boolean {
  return token?.type === 'punct' && token.value === value;
}

/** `f(<string>` followed by `)` or `,`, i.e. a call whose first argument is a literal. */
function callArgument(tokens: Token[], calleeIndex: number): Token | null {
  if (!isPunct(tokens[calleeIndex + 1], '(')) return null;
  const argument = tokens[calleeIndex + 2];
  if (argument?.type !== 'string') return null;
  const after = tokens[calleeIndex + 3];
  if (!isPunct(after, ')') && !isPunct(after, ',')) return null;
  return argument;
}

/**
 * Every module specifier in `source`, in source order, with exact spans.
 *
 * Recognized forms: `import x from "s"`, `import "s"`, `export … from "s"`,
 * `import("s")`, and `require("s")`. Specifiers written as template literals or
 * computed expressions are deliberately not reported, because they cannot be
 * rewritten without changing behavior.
 */
export function scanModuleSpecifiers(source: string): ModuleSpecifier[] {
  const tokens = tokenize(source);
  const out: ModuleSpecifier[] = [];
  let pending: 'import' | 'export' | null = null;

  const emit = (kind: SpecifierKind, token: Token): void => {
    out.push({ kind, value: token.value, start: token.start, end: token.end });
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'punct' && token.value === ';') {
      pending = null;
      continue;
    }
    if (token.type !== 'ident') continue;
    // `obj.import(…)` / `obj.require(…)` are ordinary property calls.
    if (isPunct(tokens[i - 1], '.')) continue;

    if (token.value === 'import') {
      const next = tokens[i + 1];
      if (next?.type === 'string') {
        emit('import', next);
        pending = null;
        i++;
        continue;
      }
      const dynamic = callArgument(tokens, i);
      if (dynamic) {
        emit('dynamic-import', dynamic);
        pending = null;
        i += 2;
        continue;
      }
      pending = 'import';
      continue;
    }

    if (token.value === 'export') {
      pending = 'export';
      continue;
    }

    if (token.value === 'require') {
      const argument = callArgument(tokens, i);
      if (argument) {
        emit('require', argument);
        i += 2;
      }
      continue;
    }

    if (token.value === 'from' && pending != null) {
      const next = tokens[i + 1];
      if (next?.type === 'string') {
        emit(pending, next);
        pending = null;
        i++;
      }
    }
  }

  return out;
}

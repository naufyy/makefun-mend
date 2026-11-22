// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** The move edits that succeeded, as [old, new] pairs (section 2's R lines). */
  readonly moves: [string, string][] = [];
}

type Edit = (tree: Tree) => void;

/** A file's text as SPEC.md section 3 reads it: its own line break, its lines, and whether it ends with a break. */
interface FileText {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileText {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(f: FileText): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];
const TIERS: ((s: string) => string)[] = [(s) => s, trimEndWs, trimWs];

/** The occurrences of `old` in `lines` at the first tier with one (section 5), or null when there is none. */
function findAll(lines: string[], old: string[], strict: boolean, from = 0): { tier: number; at: number[] } | null {
  for (let tier = 0; tier < (strict ? 1 : 3); tier += 1) {
    const norm = TIERS[tier]!;
    const o = old.map(norm);
    const at: number[] = [];
    for (let i = from; i + o.length <= lines.length; i += 1) {
      let ok = true;
      for (let j = 0; j < o.length && ok; j += 1) ok = norm(lines[i + j]!) === o[j];
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of a hunk or chunk: ' ' context, '-' old, '+' new. */
interface BodyLine {
  kind: ' ' | '-' | '+';
  text: string;
}

const oldOf = (body: BodyLine[]): string[] => body.filter((b) => b.kind !== '+').map((b) => b.text);
const newOf = (body: BodyLine[]): string[] => body.filter((b) => b.kind !== '-').map((b) => b.text);

/**
 * The lines that replace the matched lines lines[at..at+|O|) (section 5): context lines are the file's own, and at
 * tier 2 the other new lines are re-indented.
 */
function replacement(lines: string[], at: number, body: BodyLine[], tier: number): string[] {
  const old = oldOf(body);
  const f = at < lines.length ? leadWs(lines[at]!) : '';
  const p = old.length > 0 ? leadWs(old[0]!) : '';
  const out: string[] = [];
  let oi = 0;
  for (const b of body) {
    if (b.kind === ' ') out.push(lines[at + oi]!);
    else if (b.kind === '+') out.push(tier === 2 && !blank(b.text) && b.text.startsWith(p) ? f + b.text.slice(p.length) : b.text);
    if (b.kind !== '+') oi += 1;
  }
  return out;
}

function checkSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

/** The current text of a file that must exist, else `missing`. */
function existing(tree: Tree, p: string): string {
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return t;
}

function absent(tree: Tree, p: string): void {
  if (tree.get(p) !== null) throw new Fail('exists', p);
}

// ---- Unified diffs (section 6) ----

interface Hunk {
  a: number;
  body: BodyLine[];
  /** For each body line, whether a `\` line follows it. */
  noEol: boolean[];
}

/** The `diff --git a/<X> b/<Y>` paths, or null when the line is not of that form. */
function gitPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const cuts: number[] = [];
  for (let k = rest.indexOf(' b/', 2); k >= 0; k = rest.indexOf(' b/', k + 1)) cuts.push(k);
  const pairs = cuts.map((k): [string, string] => [rest.slice(2, k), rest.slice(k + 3)]).filter(([x, y]) => x !== '' && y !== '');
  if (pairs.length === 0) return null;
  return pairs.find(([x, y]) => x === y) ?? pairs[0]!;
}

/** The path a `--- `/`+++ ` line names: null for /dev/null. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.replace(/^ +| +$/g, '');
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  interface Section {
    git: [string, string] | null;
    pair: [string | null, string | null] | null;
    rename: [string | undefined, string | undefined];
    create: boolean;
    del: boolean;
    hunks: Hunk[];
  }
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const pairAt = (i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  const open = (git: [string, string] | null): Section => {
    const s: Section = { git, pair: null, rename: [undefined, undefined], create: false, del: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const g = gitPaths(l);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      open(g);
      i += 1;
      continue;
    }
    if (pairAt(i)) {
      const s: Section = cur !== null && inHeader && (cur as Section).pair === null ? cur : open(null);
      s.pair = [headerPath(l), headerPath(lines[i + 1]!)];
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK.exec(l);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const body: BodyLine[] = [];
      const noEol: boolean[] = [];
      let j = i + 1;
      let lastNonEmpty = 0; // body length up to its last non-empty patch line
      let bodyEnd = j;
      for (; j < lines.length; j += 1) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ') || pairAt(j)) break;
        const c = b[0];
        if (b === '') body.push({ kind: ' ', text: '' }), noEol.push(false);
        else if (c === ' ' || c === '-' || c === '+') {
          body.push({ kind: c, text: b.slice(1) });
          noEol.push(false);
        } else if (c === '\\') {
          if (body.length > 0) noEol[body.length - 1] = true;
        } else break;
        if (b !== '') {
          lastNonEmpty = body.length;
          bodyEnd = j + 1;
        }
      }
      body.length = lastNonEmpty;
      noEol.length = lastNonEmpty;
      (cur as Section).hunks.push({ a: Number(m[1]), body, noEol });
      i = bodyEnd;
      continue;
    }
    if (cur !== null && inHeader) {
      const s = cur as Section;
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) s.rename[0] = l.slice(12).trim();
      else if (l.startsWith('rename to ')) s.rename[1] = l.slice(10).trim();
      else if (l.startsWith('new file mode')) s.create = true;
      else if (l.startsWith('deleted file mode')) s.del = true;
    }
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

function sectionEdit(
  s: { git: [string, string] | null; pair: [string | null, string | null] | null; rename: [string | undefined, string | undefined]; create: boolean; del: boolean; hunks: Hunk[] },
  strict: boolean,
): Edit {
  const oldP: string | null = s.pair !== null ? s.pair[0] : (s.rename[0] ?? s.git?.[0] ?? null);
  const newP: string | null = s.pair !== null ? s.pair[1] : (s.rename[1] ?? s.git?.[1] ?? null);
  if (oldP === null || s.create) {
    const p = newP ?? oldP ?? '';
    return (tree) => {
      checkSafe(p);
      absent(tree, p);
      const add: string[] = [];
      let noEol = false;
      for (const h of s.hunks)
        h.body.forEach((b, k) => {
          if (b.kind !== '+') return;
          add.push(b.text);
          noEol = h.noEol[k]!;
        });
      tree.now.set(p, joinFile({ br: '\n', lines: add, final: !noEol }));
    };
  }
  if (newP === null || s.del) {
    const p = oldP;
    return (tree) => {
      checkSafe(p);
      existing(tree, p);
      tree.now.set(p, null);
    };
  }
  const from = oldP;
  const to = newP;
  return (tree) => {
    checkSafe(from);
    if (to !== from) checkSafe(to);
    const f = splitFile(existing(tree, from));
    if (to !== from) absent(tree, to);
    let d = 0;
    for (const h of s.hunks) {
      const old = oldOf(h.body);
      const nw = newOf(h.body);
      let lastNew = -1;
      h.body.forEach((b, k) => {
        if (b.kind !== '-') lastNew = k;
      });
      const endNoEol = lastNew >= 0 && h.noEol[lastNew]!;
      let at: number;
      let tier = 0;
      if (old.length === 0) {
        at = Math.max(0, Math.min(f.lines.length, h.a + d));
      } else {
        const found = findAll(f.lines, old, strict);
        if (found === null) throw new Fail('no-match', from);
        tier = found.tier;
        const want = h.a - 1 + d;
        at = found.at[0]!;
        for (const k of found.at) if (Math.abs(k - want) < Math.abs(at - want)) at = k;
      }
      if (at + old.length === f.lines.length) f.final = !endNoEol;
      f.lines.splice(at, old.length, ...replacement(f.lines, at, h.body, tier));
      d += nw.length - old.length;
    }
    tree.now.set(to, joinFile(f));
    if (to !== from) {
      tree.now.set(from, null);
      tree.moves.push([from, to]);
    }
  };
}

// ---- SEARCH/REPLACE blocks (section 7) ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const marker = (k: number, m: string): boolean => lines[k]!.trimEnd() === m;
  let start = 0;
  let prev: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (!marker(i, '<<<<<<< SEARCH')) continue;
    let path: string | null = null;
    for (let k = i - 1; k >= start && path === null; k -= 1) {
      const t = lines[k]!.trim();
      if (t !== '' && !t.startsWith('```')) path = t;
    }
    path ??= prev;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    let eq = i + 1;
    while (eq < lines.length && !marker(eq, '=======')) eq += 1;
    let end = eq + 1;
    while (end < lines.length && !marker(end, '>>>>>>> REPLACE')) end += 1;
    if (end >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    const p = path;
    const old = lines.slice(i + 1, eq);
    const nw = lines.slice(eq + 1, end);
    edits.push((tree) => {
      checkSafe(p);
      if (old.length === 0) {
        absent(tree, p);
        tree.now.set(p, joinFile({ br: '\n', lines: nw, final: true }));
        return;
      }
      const f = splitFile(existing(tree, p));
      const found = findAll(f.lines, old, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.at.length > 1) throw new Fail('ambiguous', p);
      const at = found.at[0]!;
      const body: BodyLine[] = [...old.map((t): BodyLine => ({ kind: '-', text: t })), ...nw.map((t): BodyLine => ({ kind: '+', text: t }))];
      f.lines.splice(at, old.length, ...replacement(f.lines, at, body, found.tier));
      tree.now.set(p, joinFile(f));
    });
    prev = p;
    start = end + 1;
    i = end;
  }
  return edits;
}

// ---- V4A patches (section 8) ----

interface Chunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (blank(lines[last]!)) last -= 1;
  if (last === first || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const HEADS = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    const head = HEADS.find((h) => l.startsWith(h));
    if (head === undefined) {
      if (blank(l)) {
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const p = l.slice(head.length).trim();
    let end = i + 1;
    while (end < last && !HEADS.some((h) => lines[end]!.startsWith(h))) end += 1;
    let stop = end;
    while (stop > i + 1 && blank(lines[stop - 1]!)) stop -= 1;
    const headLine = i;
    const body = lines.slice(i + 1, stop);
    if (head === HEADS[0]) {
      const add = body.map((b, k) => {
        if (b === '') return '';
        if (b.startsWith('+')) return b.slice(1);
        throw new Exit2(`error: parse ${i + 2 + k}`);
      });
      edits.push((tree) => {
        checkSafe(p);
        absent(tree, p);
        tree.now.set(p, joinFile({ br: '\n', lines: add, final: true }));
      });
    } else if (head === HEADS[1]) {
      if (body.length > 0) throw new Exit2(`error: parse ${i + 2}`);
      edits.push((tree) => {
        checkSafe(p);
        existing(tree, p);
        tree.now.set(p, null);
      });
    } else {
      let k = 0;
      let move: string | null = null;
      if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
        move = body[0]!.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: Chunk[] = [];
      let open: Chunk | null = null;
      for (; k < body.length; k += 1) {
        const b = body[k]!;
        const c = b[0];
        if (b.startsWith('@@')) {
          const a = b.slice(2).trim();
          open = { anchor: a === '' ? null : a, body: [], eof: false };
          chunks.push(open);
        } else if (b.trimEnd() === '*** End of File') {
          if (open === null) chunks.push({ anchor: null, body: [], eof: true });
          else open.eof = true;
          open = null;
        } else if (b === '' || c === ' ' || c === '-' || c === '+') {
          if (open === null) {
            open = { anchor: null, body: [], eof: false };
            chunks.push(open);
          }
          open.body.push(b === '' ? { kind: ' ', text: '' } : { kind: c as ' ' | '-' | '+', text: b.slice(1) });
        } else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      if (chunks.length === 0 && move === null) throw new Exit2(`error: parse ${headLine + 1}`);
      const to = move;
      edits.push((tree) => {
        checkSafe(p);
        if (to !== null) checkSafe(to);
        const f = splitFile(existing(tree, p));
        if (to !== null) absent(tree, to);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const found = findAll(f.lines, [ch.anchor], strict, cursor);
            if (found === null) throw new Fail('no-match', p);
            cursor = found.at[0]! + 1;
          }
          const old = oldOf(ch.body);
          let at: number;
          let tier = 0;
          if (old.length === 0) at = ch.eof ? f.lines.length : cursor;
          else {
            let hit: { tier: number; at: number } | null = null;
            for (let t = 0; t < (strict ? 1 : 3) && hit === null; t += 1) {
              const norm = TIERS[t]!;
              const o = old.map(norm);
              for (let s = cursor; s + o.length <= f.lines.length && hit === null; s += 1) {
                if (ch.eof && s + o.length !== f.lines.length) continue;
                let ok = true;
                for (let j = 0; j < o.length && ok; j += 1) ok = norm(f.lines[s + j]!) === o[j];
                if (ok) hit = { tier: t, at: s };
              }
            }
            if (hit === null) throw new Fail('no-match', p);
            at = hit.at;
            tier = hit.tier;
          }
          const rep = replacement(f.lines, at, ch.body, tier);
          f.lines.splice(at, old.length, ...rep);
          cursor = at + rep.length;
        }
        if (to !== null && to !== p) {
          tree.now.set(to, joinFile(f));
          tree.now.set(p, null);
          tree.moves.push([p, to]);
        } else tree.now.set(p, joinFile(f));
      });
    }
    i = end;
  }
  return edits;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A successful move whose old path is gone and whose new path is new is one R line, in place of its D and A lines.
  const renamed = new Map<string, string>(); // new path -> old path
  const paired = new Set<string>();
  for (const [from, to] of tree.moves) {
    if (paired.has(from) || paired.has(to)) continue;
    if (tree.original(from) !== null && tree.get(from) === null && tree.original(to) === null && tree.get(to) !== null) {
      renamed.set(to, from);
      paired.add(from);
      paired.add(to);
    }
  }
  const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const listed: [string, string][] = [];
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (renamed.has(p)) listed.push([p, `R ${renamed.get(p)} -> ${p}`]);
    else if (!paired.has(p)) listed.push([p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`]);
  }
  const rows = listed.sort((a, b) => byteOrder(a[0], b[0])).map(([, r]) => r);
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

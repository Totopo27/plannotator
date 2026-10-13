/**
 * Plannotator Inbox search: an in-memory inverted index over the store,
 * built lazily on the first search in slices that yield, and kept current
 * from the store's lines. The design of record is the approved "inbox-search"
 * brief (owner approval 2026-10-13; not in this repo); what a build here
 * needs from it is in CLAUDE.md ("Search" under "Plannotator Inbox").
 *
 * What is indexed, one document each:
 *   thread    its subject (the current one, following a replaced question's
 *             subject) and thread name (title fields), its project's name
 *   message   an agent message's body as text (question blocks, images and
 *             link targets dropped; code kept as text), each question's
 *             prompt, context, choice labels and the person's answer, the
 *             agent's name; the person's own reply words (not the generated
 *             "Answered N questions." line, not the answers section); the
 *             Inbox's own notes (set aside, reopened) are not indexed
 *   file      an attachment's name (title) and the last two path segments
 *   guide     a guided review's title
 *   decision  its text (title) and reason
 *   project   its name (title) and root
 *
 * Text rules (normalization, tokens, ranges, snippets) are
 * @plannotator/core/inbox-search, which the window shares.
 *
 * A query's terms must all match, the last one as a prefix. Ranking inside a
 * group: the match tier (the terms as a phrase, then every term as a whole
 * word, then the last as a prefix; inside a tier a match in title fields
 * first), then open before archived, then the project the person searches
 * from (ties only, never a filter), then the newest.
 */

import {
  inboxSearchRanges,
  inboxSearchSnippet,
  inboxSearchTerms,
  scanInboxSearchTokens,
  tokenizeInboxSearchText,
  INBOX_SEARCH_BROWSE_LIMIT,
  INBOX_SEARCH_CAPS,
  INBOX_SEARCH_GROUPS,
  INBOX_SEARCH_LIMIT_MAX,
  INBOX_SEARCH_RECENT_THREADS,
  type InboxSearchAnswer,
  type InboxSearchFrom,
  type InboxSearchGroupId,
  type InboxSearchProjectRef,
  type InboxSearchQuery,
  type InboxSearchRow,
  type InboxSearchThreadRow,
} from "@plannotator/core/inbox-search";
import { findQuestionBlocks, QUESTION_ANSWERS_HEADING, type QuestionAnswer } from "@plannotator/core/question-block";
import {
  inboxAgentName,
  isInboxNote,
  type InboxDecision,
  type InboxLine,
  type InboxListRow,
  type InboxMessage,
  type InboxProject,
  type InboxQuestion,
  type InboxSectionId,
} from "@plannotator/core/inbox-types";
import { inboxRowArchived } from "./list";
import type { InboxStore } from "./store";

// The wire (answers, rows, the query) is @plannotator/core/inbox-search's, so the window reads it without this package.
export {
  INBOX_SEARCH_BROWSE_LIMIT,
  INBOX_SEARCH_CAPS,
  INBOX_SEARCH_GROUPS,
  INBOX_SEARCH_LIMIT_MAX,
  INBOX_SEARCH_RECENT_THREADS,
  INBOX_SEARCH_STATUSES,
  type InboxSearchAnswer,
  type InboxSearchDecisionRow,
  type InboxSearchFileRow,
  type InboxSearchFrom,
  type InboxSearchGroupId,
  type InboxSearchMessageRow,
  type InboxSearchProjectRef,
  type InboxSearchProjectRow,
  type InboxSearchQuery,
  type InboxSearchRow,
  type InboxSearchStatus,
  type InboxSearchThreadRow,
} from "@plannotator/core/inbox-search";

// ─────────────────────────────── Text ───────────────────────────────

const ANSWERS_HEADING_LINE = new RegExp(`^#{1,6}\\s+${QUESTION_ANSWERS_HEADING}\\s*$`);

/** A line with something `plainInline` rewrites. */
const INLINE_MARKUP = /[[<*_~`|]/;

/** Inline markdown as plain text: images out, link labels kept (targets dropped), tags and emphasis marks out, code kept. */
function plainInline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, target: string, label?: string) => label ?? target)
    .replace(/<(?:https?|mailto):[^>\s]*>/g, "")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/(^|[^\w*~])(\*\*|__|~~|\*)(?=\S)([^\n]*?\S)\2(?=$|[\s,;:!?)\]"'.])/g, "$1$3")
    .replace(/`+/g, "");
}

/**
 * A message's markdown as the text search reads and snippets show: question
 * blocks out (their prompts, choices and answers are indexed on the
 * question), fences' markers out and their code kept, block marks out,
 * table pipes as spaces, link labels kept and targets dropped, images out.
 */
export function inboxSearchBodyText(markdown: string): string {
  const out: string[] = [];
  forEachInboxSearchBodyLine(markdown, (line) => out.push(line));
  return out.join("\n").trim();
}

/** `inboxSearchBodyText`'s lines, one at a time (the index tokenizes them without joining them). */
export function forEachInboxSearchBodyLine(markdown: string, visit: (line: string) => void): void {
  const skips = markdown.includes(":::question") ? findQuestionBlocks(markdown, { frontmatter: false }).map((b) => [b.startLine, b.endLine] as const) : [];
  let fence: string | null = null;
  let lineNo = 0;
  for (let at = 0; at <= markdown.length; ) {
    let next = markdown.indexOf("\n", at);
    if (next < 0) next = markdown.length;
    let raw = markdown.slice(at, next);
    at = next + 1;
    lineNo += 1;
    if (raw.endsWith("\r")) raw = raw.slice(0, -1);
    if (skips.length > 0 && skips.some(([from, to]) => lineNo >= from && lineNo <= to)) continue;
    const line = raw.trim();
    if (fence !== null) {
      if (line.startsWith(fence)) fence = null;
      else visit(raw);
      continue;
    }
    if (line.length === 0) continue;
    const first = line.charCodeAt(0);
    if (first === 0x60 || first === 0x7e) {
      const open = /^(`{3,}|~{3,})/.exec(line);
      if (open) {
        fence = open[1]!;
        continue;
      }
    }
    // Most lines are prose: only a line that starts with a mark, or holds inline markup, is rewritten.
    const marked = first === 0x23 || first === 0x3e || first === 0x2d || first === 0x2a || first === 0x2b || first === 0x3a || first === 0x7c || first === 0x5f || (first >= 0x30 && first <= 0x39);
    if (marked && (/^:{3,}/.test(line) || /^[-*_]{3,}$/.test(line) || /^\|?\s*:?-{3,}/.test(line))) continue;
    let text = marked ? line.replace(/^#{1,6}\s+/, "").replace(/^>\s?/, "").replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "") : line;
    if (INLINE_MARKUP.test(text)) text = plainInline(text.replace(/\|/g, " "));
    visit(text);
  }
}

/** The person's own words in a reply: not the generated first line, not the answers section. */
export function inboxSearchReplyText(body: string): string {
  const lines = body.split(/\r?\n/);
  const at = lines.findIndex((line) => ANSWERS_HEADING_LINE.test(line.trim()));
  const kept = (at >= 0 ? lines.slice(0, at) : lines).join("\n");
  return inboxSearchBodyText(kept.replace(/^\s*(?:Answered \d+ questions?(?:, skipped \d+)?|Skipped \d+ questions?)\.\s*/, ""));
}

function answerText(answer: QuestionAnswer | null): string {
  if (!answer || answer.skipped) return "";
  const parts = [...answer.selected];
  if (answer.other) parts.push(answer.other);
  if (answer.text) parts.push(answer.text);
  return parts.join(", ");
}

function fileFolder(path: string): string | null {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2]! : null;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase().slice(0, 8) : "file";
}

/** Marks as the wire carries them: [start, length]. */
function toMarks(ranges: readonly [number, number][]): [number, number][] {
  return ranges.map(([a, b]) => [a, b - a]);
}

// ─────────────────────────────── Index ───────────────────────────────

type DocType = "thread" | "message" | "file" | "guide" | "decision" | "project";

interface Doc {
  key: string;
  type: DocType;
  /** The record's id (thread root, message, attachment, guide's message, decision, project). */
  ref: string;
  threadId: string | null;
  projectId: string;
  at: number;
  /** Who wrote it, for From (a thread's comes from its facts). */
  from: InboxSearchFrom | null;
  /**
   * The token sequence as varints (token ids; 0 separates fields, so a phrase
   * never spans two). Title fields come first. Most ids are small, so most
   * tokens take one byte.
   */
  tokens: Uint8Array;
  /** Tokens in the sequence, separators included. */
  count: number;
  /** How many leading tokens are the title fields. */
  titleLen: number;
  /** What the fields were made from (their changeable parts): a re-index that changes nothing is skipped. */
  sig: string;
}

/**
 * Token ids by string, an open-addressing table over FNV-1a hashes of the
 * folded characters. `idOfSpan` looks an ASCII token up straight from the
 * text it sits in (lower-casing as it hashes), so the build makes a string
 * only for a token it has never seen.
 */
class TokenTable {
  private slots = new Int32Array(1 << 16);
  private hashes: number[] = [0];
  private count = 0;
  constructor(private readonly words: string[]) {}

  private static hash(token: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 0x01000193);
    return h >>> 0;
  }

  /** The id of a folded token, or -1. */
  idOf(token: string): number {
    const h = TokenTable.hash(token);
    const mask = this.slots.length - 1;
    for (let i = h & mask; ; i = (i + 1) & mask) {
      const slot = this.slots[i]!;
      if (slot === 0) return -1;
      const id = slot - 1;
      if (this.hashes[id] === h && this.words[id] === token) return id;
    }
  }

  /** The id of the ASCII token `text[start, end)` (lower-cased when `upper`), or -1. */
  idOfSpan(text: string, start: number, end: number, upper: boolean): number {
    let h = 0x811c9dc5;
    for (let k = start; k < end; k++) {
      let c = text.charCodeAt(k);
      if (upper && c >= 0x41 && c <= 0x5a) c += 0x20;
      h = Math.imul(h ^ c, 0x01000193);
    }
    h >>>= 0;
    const mask = this.slots.length - 1;
    const length = end - start;
    for (let i = h & mask; ; i = (i + 1) & mask) {
      const slot = this.slots[i]!;
      if (slot === 0) return -1;
      const id = slot - 1;
      if (this.hashes[id] !== h) continue;
      const word = this.words[id]!;
      if (word.length !== length) continue;
      let same = true;
      for (let k = 0; k < length; k++) {
        let c = text.charCodeAt(start + k);
        if (upper && c >= 0x41 && c <= 0x5a) c += 0x20;
        if (word.charCodeAt(k) !== c) {
          same = false;
          break;
        }
      }
      if (same) return id;
    }
  }

  /** Add a folded token (not present) and return its id. */
  add(token: string): number {
    const id = this.words.length;
    this.words.push(token);
    const h = TokenTable.hash(token);
    this.hashes[id] = h;
    this.count += 1;
    if (this.count * 2 > this.slots.length) this.grow();
    else this.place(id, h);
    return id;
  }

  private place(id: number, h: number): void {
    const mask = this.slots.length - 1;
    let i = h & mask;
    while (this.slots[i] !== 0) i = (i + 1) & mask;
    this.slots[i] = id + 1;
  }

  private grow(): void {
    this.slots = new Int32Array(this.slots.length * 2);
    for (let id = 1; id < this.words.length; id++) this.place(id, this.hashes[id]!);
  }
}

/** A growable byte buffer for varints. */
class Bytes {
  buf: Uint8Array;
  len = 0;
  constructor(size = 16) {
    this.buf = new Uint8Array(size);
  }
  push(value: number): void {
    if (this.len + 5 > this.buf.length) {
      const grown = new Uint8Array(Math.max(this.buf.length * 2, this.len + 16));
      grown.set(this.buf.subarray(0, this.len));
      this.buf = grown;
    }
    let v = value;
    while (v >= 0x80) {
      this.buf[this.len++] = (v & 0x7f) | 0x80;
      v >>>= 7;
    }
    this.buf[this.len++] = v;
  }
  /** The bytes, trimmed to what was written (a copy). */
  take(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** Decode a varint sequence into `out` (grown as needed); returns the count and the buffer. */
function decodeVarints(bytes: Uint8Array, length: number, out: Int32Array, delta: boolean): { n: number; out: Int32Array } {
  let n = 0;
  let p = 0;
  let previous = 0;
  while (p < length) {
    let value = bytes[p++]!;
    if (value & 0x80) {
      value &= 0x7f;
      let shift = 7;
      let b: number;
      do {
        b = bytes[p++]!;
        value |= (b & 0x7f) << shift;
        shift += 7;
      } while (b & 0x80);
    }
    if (delta) {
      previous += value;
      value = previous;
    }
    if (n >= out.length) {
      const grown = new Int32Array(Math.max(out.length * 2, 1024));
      grown.set(out);
      out = grown;
    }
    out[n++] = value;
  }
  return { n, out };
}

/** Facts of a thread that filters and ranking read, from its list row; cached until a line touches the thread. */
interface ThreadFacts {
  projectId: string;
  section: InboxSectionId;
  archived: boolean;
  lastAt: string;
  subject: string;
  threadName: string | null;
  agent: boolean;
  me: boolean;
}

/** A field: text, or a message body read line by line as `inboxSearchBodyText` reads it. */
type Field = string | { body: string };

interface FieldSet {
  title: Field[];
  other: Field[];
}

export interface InboxSearchIndexOptions {
  /** How long a build slice works before it yields (default 5 ms: the slice that ends with a long message, or a collection, still stays under the brief's 8 ms). */
  sliceMs?: number;
  /** Yield between slices (default setImmediate, else setTimeout 0). */
  yieldNow?: () => Promise<void>;
  now?: () => number;
}

const defaultYield = (): Promise<void> =>
  new Promise((resolve) => (typeof setImmediate === "function" ? setImmediate(resolve) : setTimeout(resolve, 0)));

/** What a build or a flush measured (the window never sees it; tests and the benchmark read it). */
export interface InboxSearchBuildStats {
  docs: number;
  threads: number;
  tokens: number;
  vocabulary: number;
  slices: number;
  longestSliceMs: number;
  /** Slices that ran past 8 ms (the brief's bound): a collection or a long message at the end of a slice. */
  slicesOver8Ms: number;
  totalMs: number;
}

export class InboxSearchIndex {
  private readonly store: InboxStore;
  private readonly sliceMs: number;
  private readonly yieldNow: () => Promise<void>;
  private readonly now: () => number;

  private docs: (Doc | null)[] = [];
  private byKey = new Map<string, number>();
  private dead = 0;
  /** Token strings by id (0 is the field separator), and the table that finds an id from a string or a span of text. */
  private words: string[] = [""];
  private table = new TokenTable(this.words);
  /** Each token's documents, delta-encoded varints in increasing document order (a document number is never reused). */
  private postBuf: Bytes[] = [new Bytes(1)];
  private postLast: number[] = [0];
  private postCount: number[] = [0];
  /** Token ids in string order, for the last term's prefix; ids added since the last sort wait in `pending`. */
  private sorted: Int32Array | null = null;
  private pending: number[] = [];
  private facts = new Map<string, ThreadFacts>();
  /** Project names as indexed into thread documents, to notice a rename. */
  private projectNames = new Map<string, string>();

  private built = false;
  private building: Promise<void> | null = null;
  private generation = 0;
  private reloadsSeen = -1;
  private buildTotal = 0;
  private stats: InboxSearchBuildStats | null = null;

  private dirtyThreads = new Set<string>();
  private dirtyMessages = new Set<string>();
  private dirtyDecisions = new Set<string>();
  private dirtyProjects = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  // Query scratch, reused.
  private mark = new Int32Array(0);
  private epoch = 0;
  private termOf = new Int32Array(0);
  private tokenMark = new Int32Array(0);
  private tokenEpoch = 0;
  private seq = new Bytes(4096);

  constructor(store: InboxStore, options: InboxSearchIndexOptions = {}) {
    this.store = store;
    this.sliceMs = options.sliceMs ?? 5;
    this.yieldNow = options.yieldNow ?? defaultYield;
    this.now = options.now ?? (() => performance.now());
  }

  /** Stop listening to the store. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  /** The index is built and current with the store's last re-read. */
  ready(): boolean {
    return this.built && this.reloadsSeen === this.store.reloadCount() && !this.tooManyDead();
  }

  /** Threads the index covers, or is building over. */
  threadCount(): number {
    return this.building ? this.buildTotal : this.store.threadIds().length;
  }

  lastBuildStats(): InboxSearchBuildStats | null {
    return this.stats;
  }

  /** Build (or rebuild after a re-read) unless current; one build at a time, every caller awaits it. */
  ensureBuilt(): Promise<void> {
    if (this.ready()) return Promise.resolve();
    if (this.building) return this.building;
    const generation = ++this.generation;
    this.building = this.build(generation).finally(() => {
      if (this.generation === generation) this.building = null;
    });
    return this.building;
  }

  private tooManyDead(): boolean {
    return this.dead > 2000 && this.dead > this.byKey.size;
  }

  private listen(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.store.subscribe((line) => this.noteLine(line));
  }

  /** A store line marks what it touches; the next search (or a short timer) re-indexes it. */
  private noteLine(line: InboxLine): void {
    switch (line.kind) {
      case "project":
        // A new project can change the others' names too ("api" becomes "api · work"): every label is read again.
        for (const project of this.store.listProjects()) this.dirtyProjects.add(project.id);
        break;
      case "message":
        this.dirtyMessages.add(line.record.id);
        this.dirtyThreads.add(line.record.thread_id);
        break;
      case "question": {
        this.dirtyMessages.add(line.record.message_id);
        const message = this.store.message(line.record.message_id);
        if (message) this.dirtyThreads.add(message.thread_id);
        break;
      }
      case "decision":
        this.dirtyDecisions.add(line.record.id);
        break;
      case "annotation":
        return;
    }
    if (line.kind === "message" || line.kind === "question") {
      const threadId = line.kind === "message" ? line.record.thread_id : this.store.message(line.record.message_id)?.thread_id;
      if (threadId) this.facts.delete(threadId);
    }
    if (this.built && !this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        if (this.built && !this.building) this.flush();
      }, 50);
    }
  }

  private resetIndex(): void {
    this.docs = [];
    this.byKey = new Map();
    this.dead = 0;
    this.words = [""];
    this.table = new TokenTable(this.words);
    this.postBuf = [new Bytes(1)];
    this.postLast = [0];
    this.postCount = [0];
    this.sorted = null;
    this.pending = [];
    this.facts = new Map();
    this.projectNames = new Map();
  }

  private async build(generation: number): Promise<void> {
    this.listen();
    const started = this.now();
    let sliceStart = started;
    let slices = 1;
    let longest = 0;
    let over = 0;
    const reloads = this.store.reloadCount();
    this.built = false;
    this.resetIndex();
    this.dirtyThreads.clear();
    this.dirtyMessages.clear();
    this.dirtyDecisions.clear();
    this.dirtyProjects.clear();
    const threadIds = this.store.threadIds();
    this.buildTotal = threadIds.length;
    const maybeYield = async (): Promise<boolean> => {
      const t = this.now();
      if (t - sliceStart < this.sliceMs) return true;
      longest = Math.max(longest, t - sliceStart);
      if (t - sliceStart > 8) over += 1;
      await this.yieldNow();
      slices += 1;
      sliceStart = this.now();
      // A re-read or a newer build while this one waited: this build is void.
      return this.generation === generation && this.store.reloadCount() === reloads;
    };
    for (const project of this.store.listProjects()) this.indexProject(project);
    for (const threadId of threadIds) {
      // A slice ends between messages, so one thread of long messages never holds the server.
      for (const id of this.store.threadMessageIds(threadId)) {
        const message = this.store.message(id);
        if (message) this.indexMessage(message);
        if (!(await maybeYield())) return;
      }
      this.indexThread(threadId, false);
      if (!(await maybeYield())) return;
    }
    for (const decision of [...this.store.allDecisions()]) {
      this.indexDecision(decision as InboxDecision);
      if (!(await maybeYield())) return;
    }
    longest = Math.max(longest, this.now() - sliceStart);
    if (this.generation !== generation || this.store.reloadCount() !== reloads) return;
    this.sortVocabulary();
    this.reloadsSeen = reloads;
    this.built = true;
    // Lines that arrived while building touched records already read or not yet: re-index them now.
    this.flush();
    let tokens = 0;
    for (const doc of this.docs) if (doc) tokens += doc.count;
    this.stats = {
      docs: this.byKey.size,
      threads: threadIds.length,
      tokens,
      vocabulary: this.words.length - 1,
      slices,
      longestSliceMs: longest,
      slicesOver8Ms: over,
      totalMs: this.now() - started,
    };
  }

  /** Re-index what lines touched since the last flush. Runs before every search. */
  flush(): void {
    if (!this.built) return;
    for (const id of this.dirtyProjects) {
      const project = this.store.project(id);
      if (project) {
        const renamed = this.projectNames.has(id) && this.projectNames.get(id) !== project.name;
        this.indexProject(project);
        if (renamed) for (const threadId of this.store.threadIds()) if (this.store.message(threadId)?.project_id === id) this.dirtyThreads.add(threadId);
      }
    }
    this.dirtyProjects.clear();
    for (const id of this.dirtyMessages) {
      const message = this.store.message(id);
      if (message) this.indexMessage(message);
    }
    this.dirtyMessages.clear();
    for (const threadId of this.dirtyThreads) {
      this.facts.delete(threadId);
      this.indexThread(threadId, false);
    }
    this.dirtyThreads.clear();
    for (const id of this.dirtyDecisions) {
      const decision = this.store.decision(id);
      if (decision) this.indexDecision(decision);
    }
    this.dirtyDecisions.clear();
  }

  // ── documents ──

  /** A new token's postings start empty; a prefix search finds it in `pending` until the next sort. */
  private added(id: number): number {
    this.postBuf.push(new Bytes(4));
    this.postLast.push(0);
    this.postCount.push(0);
    if (this.sorted) this.pending.push(id);
    return id;
  }

  private tokenId(token: string): number {
    const id = this.table.idOf(token);
    return id >= 0 ? id : this.added(this.table.add(token));
  }

  private spanId(text: string, start: number, end: number, upper: boolean): number {
    const id = this.table.idOfSpan(text, start, end, upper);
    if (id >= 0) return id;
    const raw = text.slice(start, end);
    return this.added(this.table.add(upper ? raw.toLowerCase() : raw));
  }

  private sortVocabulary(): void {
    const words = this.words;
    const ids = Array.from({ length: words.length - 1 }, (_, i) => i + 1);
    ids.sort((a, b) => (words[a]! < words[b]! ? -1 : words[a]! > words[b]! ? 1 : 0));
    this.sorted = Int32Array.from(ids);
    this.pending = [];
  }

  private put(key: string, type: DocType, meta: { ref: string; threadId: string | null; projectId: string; at: string; from: InboxSearchFrom | null }, fields: FieldSet, sig: string): void {
    const existing = this.byKey.get(key);
    const at = Date.parse(meta.at) || 0;
    if (existing !== undefined) {
      const doc = this.docs[existing]!;
      if (doc.sig === sig) {
        doc.at = at;
        doc.from = meta.from;
        doc.projectId = meta.projectId;
        return;
      }
      this.remove(key);
    }
    const seq = this.seq;
    seq.len = 0;
    let count = 0;
    let lastWasToken = false;
    // The document's number, and each token's posting written the first time the token is seen in it.
    const number = this.docs.length;
    const epoch = this.nextTokenEpoch();
    const add = (id: number) => {
      seq.push(id);
      count += 1;
      lastWasToken = true;
      if (id >= this.tokenMark.length) this.growTokenMark();
      if (this.tokenMark[id] === epoch) return;
      this.tokenMark[id] = epoch;
      this.postBuf[id]!.push(number - this.postLast[id]!);
      this.postLast[id] = number;
      this.postCount[id]! += 1;
    };
    const visit = (token: string) => add(this.tokenId(token));
    let current = "";
    const visitSpan = (start: number, end: number, upper: boolean) => add(this.spanId(current, start, end, upper));
    const scan = (text: string) => {
      current = text;
      scanInboxSearchTokens(text, visitSpan, visit);
    };
    const push = (fields: Field[]) => {
      for (const field of fields) {
        if (!field) continue;
        if (lastWasToken) {
          seq.push(0);
          count += 1;
          lastWasToken = false;
        }
        if (typeof field === "string") scan(field);
        else forEachInboxSearchBodyLine(field.body, scan);
      }
    };
    push(fields.title);
    const titleLen = count;
    push(fields.other);
    if (count === 0) return;
    const tokens = seq.take();
    this.docs.push({ key, type, ref: meta.ref, threadId: meta.threadId, projectId: meta.projectId, at, from: meta.from, tokens, count, titleLen, sig });
    this.byKey.set(key, number);
  }

  private growTokenMark(): void {
    const grown = new Int32Array(Math.max(this.words.length * 2, 1024));
    grown.set(this.tokenMark);
    this.tokenMark = grown;
  }

  /** A fresh mark for "this token was seen in this document". */
  private nextTokenEpoch(): number {
    if (this.tokenMark.length < this.words.length) this.growTokenMark();
    this.tokenEpoch += 1;
    if (this.tokenEpoch > 0x7ffffff0) {
      this.tokenMark.fill(0);
      this.tokenEpoch = 1;
    }
    return this.tokenEpoch;
  }

  /** A token's documents (live or not), in increasing order. */
  private postingsOf(id: number): Int32Array {
    const bytes = this.postBuf[id]!;
    const decoded = decodeVarints(bytes.buf, bytes.len, new Int32Array(Math.max(1, this.postCount[id]!)), true);
    return decoded.out.subarray(0, decoded.n);
  }

  private remove(key: string): void {
    const number = this.byKey.get(key);
    if (number === undefined) return;
    this.docs[number] = null;
    this.byKey.delete(key);
    this.dead += 1;
  }

  private indexProject(project: InboxProject): void {
    this.projectNames.set(project.id, project.name);
    this.put(`p:${project.id}`, "project", { ref: project.id, threadId: null, projectId: project.id, at: project.created_at, from: null }, { title: [project.name], other: [project.root] }, `${project.name}\u0001${project.root}`);
  }

  private indexDecision(decision: InboxDecision): void {
    this.put(
      `d:${decision.id}`,
      "decision",
      { ref: decision.id, threadId: decision.source.thread_id, projectId: decision.project_id, at: decision.changed_at ?? decision.created_at, from: decision.source.kind === "agent" ? "agent" : "me" },
      { title: [decision.text], other: decision.reason ? [decision.reason] : [] },
      `${decision.text}\u0001${decision.reason ?? ""}`,
    );
  }

  /** A thread's own document; with `withMessages`, its messages' too (the build). */
  private indexThread(threadId: string, withMessages: boolean): void {
    const root = this.store.message(threadId);
    if (!root || root.thread_id !== threadId) {
      this.remove(`t:${threadId}`);
      this.facts.delete(threadId);
      return;
    }
    if (withMessages) for (const id of this.store.threadMessageIds(threadId)) {
      const message = this.store.message(id);
      if (message) this.indexMessage(message);
    }
    const facts = this.factsOf(threadId);
    const project = this.store.project(root.project_id);
    const subject = facts?.subject ?? root.subject ?? "";
    this.put(
      `t:${threadId}`,
      "thread",
      { ref: threadId, threadId, projectId: root.project_id, at: facts?.lastAt ?? root.created_at, from: null },
      { title: [subject, root.thread_name ?? ""], other: project ? [project.name] : [] },
      `${subject}\u0001${root.thread_name ?? ""}\u0001${project?.name ?? ""}`,
    );
  }

  private indexMessage(message: InboxMessage): void {
    const meta = { ref: message.id, threadId: message.thread_id, projectId: message.project_id, at: message.created_at };
    if (message.author.kind === "person") {
      if (isInboxNote(message)) return;
      // A message's body never changes once stored: its length stands for it.
      this.put(`m:${message.id}`, "message", { ...meta, from: "me" }, { title: [], other: [inboxSearchReplyText(message.body)] }, `${message.body.length}`);
      return;
    }
    const questions = this.store.questionsOf(message.id).flatMap(questionTexts);
    const name = inboxAgentName(message.author);
    const sig = `${message.body.length}\u0001${name}\u0001${questions.join("\u0001")}`;
    const existing = this.byKey.get(`m:${message.id}`);
    if (existing === undefined || this.docs[existing]!.sig !== sig) {
      this.put(`m:${message.id}`, "message", { ...meta, from: "agent" }, { title: [], other: [{ body: message.body }, ...questions, name] }, sig);
    } else {
      this.docs[existing]!.at = Date.parse(message.created_at) || 0;
    }
    for (const attachment of message.attachments ?? []) {
      const tail = attachment.path.split(/[\\/]+/).slice(-2).join("/");
      this.put(`f:${attachment.id}`, "file", { ...meta, ref: attachment.id, from: "agent" }, { title: [attachment.name], other: [tail] }, `${attachment.name}\u0001${tail}`);
    }
    if (message.guide) this.put(`g:${message.id}`, "guide", { ...meta, from: "agent" }, { title: [message.guide.title], other: [] }, message.guide.title);
  }

  // ── facts ──

  private factsOf(threadId: string): ThreadFacts | null {
    const cached = this.facts.get(threadId);
    if (cached) return cached;
    const row: InboxListRow | null = this.store.listRow(threadId);
    if (!row) return null;
    let agent = false;
    let me = false;
    for (const id of this.store.threadMessageIds(threadId)) {
      const message = this.store.message(id);
      if (!message) continue;
      if (message.author.kind === "agent") agent = true;
      else if (!isInboxNote(message)) me = true;
    }
    const facts: ThreadFacts = {
      projectId: row.project.id,
      section: row.section,
      archived: inboxRowArchived(row),
      lastAt: row.last_at,
      subject: row.subject ?? "",
      threadName: row.thread_name,
      agent,
      me,
    };
    this.facts.set(threadId, facts);
    return facts;
  }

  // ── query ──

  private prefixIds(prefix: string): number[] {
    const out: number[] = [];
    if (!this.sorted) this.sortVocabulary();
    if (this.pending.length > 4000) this.sortVocabulary();
    const sorted = this.sorted!;
    const words = this.words;
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (words[sorted[mid]!]! < prefix) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < sorted.length && words[sorted[i]!]!.startsWith(prefix); i++) out.push(sorted[i]!);
    for (const id of this.pending) if (words[id]!.startsWith(prefix)) out.push(id);
    return out;
  }

  private nextEpoch(): number {
    if (this.mark.length < this.docs.length) {
      const grown = new Int32Array(Math.max(this.docs.length * 2, 1024));
      this.mark = grown;
      this.epoch = 0;
    }
    this.epoch += 1;
    if (this.epoch > 0x7ffffff0) {
      this.mark.fill(0);
      this.epoch = 1;
    }
    return this.epoch;
  }

  /** Documents holding every term (the last as a prefix), with their tier and whether the title fields hold them all. */
  private match(terms: readonly string[]): { doc: number; tier: number; title: boolean }[] {
    const n = terms.length;
    const exactIds: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const id = this.table.idOf(terms[i]!);
      if (id < 0) return [];
      exactIds.push(id);
    }
    const last = terms[n - 1]!;
    const lastExact = this.table.idOf(last);
    const prefix = this.prefixIds(last);
    if (prefix.length === 0) return [];

    if (this.termOf.length < this.words.length) this.termOf = new Int32Array(Math.max(this.words.length * 2, 1024));
    const termOf = this.termOf;
    const touched: number[] = [];
    const flag = (id: number, bit: number) => {
      if (termOf[id] === 0) touched.push(id);
      termOf[id]! |= bit;
    };
    exactIds.forEach((id, i) => flag(id, 1 << i));
    for (const id of prefix) flag(id, 1 << (n - 1));

    try {
      let candidates: Int32Array;
      const alive = (list: Int32Array) => {
        let k = 0;
        for (let i = 0; i < list.length; i++) if (this.docs[list[i]!] !== null) list[k++] = list[i]!;
        return list.subarray(0, k);
      };
      if (exactIds.length > 0) {
        const order = [...exactIds].sort((a, b) => this.postCount[a]! - this.postCount[b]!);
        candidates = alive(this.postingsOf(order[0]!));
        for (const id of order.slice(1)) {
          const epoch = this.nextEpoch();
          const list = this.postingsOf(id);
          for (let i = 0; i < list.length; i++) this.mark[list[i]!] = epoch;
          let k = 0;
          for (let i = 0; i < candidates.length; i++) if (this.mark[candidates[i]!] === epoch) candidates[k++] = candidates[i]!;
          candidates = candidates.subarray(0, k);
          if (candidates.length === 0) return [];
        }
        // The last term as a prefix: mark its documents, unless they far outnumber the candidates (then each is scanned below anyway).
        let prefixPostings = 0;
        for (const id of prefix) prefixPostings += this.postCount[id]!;
        if (prefixPostings <= candidates.length * 32) {
          const epoch = this.nextEpoch();
          for (const id of prefix) {
            const list = this.postingsOf(id);
            for (let i = 0; i < list.length; i++) this.mark[list[i]!] = epoch;
          }
          let k = 0;
          for (let i = 0; i < candidates.length; i++) if (this.mark[candidates[i]!] === epoch) candidates[k++] = candidates[i]!;
          candidates = candidates.subarray(0, k);
        }
      } else {
        const epoch = this.nextEpoch();
        let total = 0;
        for (const id of prefix) total += this.postCount[id]!;
        const out = new Int32Array(total);
        let k = 0;
        for (const id of prefix) {
          const list = this.postingsOf(id);
          for (let i = 0; i < list.length; i++) {
            const d = list[i]!;
            if (this.mark[d] === epoch || this.docs[d] === null) continue;
            this.mark[d] = epoch;
            out[k++] = d;
          }
        }
        candidates = out.subarray(0, k);
      }

      const all = (1 << n) - 1;
      const lastBit = 1 << (n - 1);
      const out: { doc: number; tier: number; title: boolean }[] = [];
      let exactEpoch = -1;
      if (n === 1 && lastExact >= 0) {
        // One term: whole when the exact token is in the document.
        exactEpoch = this.nextEpoch();
        const list = this.postingsOf(lastExact);
        for (let i = 0; i < list.length; i++) this.mark[list[i]!] = exactEpoch;
      }
      for (let c = 0; c < candidates.length; c++) {
        const d = candidates[c]!;
        const doc = this.docs[d]!;
        if (n === 1) {
          // The title needs only the leading tokens.
          out.push({ doc: d, tier: exactEpoch >= 0 && this.mark[d] === exactEpoch ? 2 : 1, title: scanTitle(doc.tokens, doc.titleLen, termOf) });
          continue;
        }
        const found = scanDocument(doc.tokens, doc.titleLen, termOf, lastExact, lastBit, all);
        if (found < 0) continue;
        out.push({ doc: d, tier: found & 3, title: (found & 4) !== 0 });
      }
      return out;
    } finally {
      for (const id of touched) termOf[id] = 0;
    }
  }

  /**
   * Answer a query. The index must be built (`ensureBuilt`); lines since the
   * last flush are re-indexed first.
   */
  search(query: InboxSearchQuery): InboxSearchAnswer {
    const started = this.now();
    this.flush();
    const q = query.q.trim();
    const terms = inboxSearchTerms(q);
    const filtered = Boolean(query.project || query.status || query.from);
    const base = { q, terms, indexing: false, threads: this.threadCount() };
    const labels = projectLabels(this.store.listProjects());
    if (terms.length === 0 && !filtered) {
      return { ...base, took_ms: this.now() - started, totals: null, groups: null, recent: this.recentThreads(labels) };
    }
    const groups: Record<InboxSearchGroupId, { doc: number; score: number }[]> = { threads: [], messages: [], files: [], decisions: [], projects: [] };

    const statusOk = (facts: ThreadFacts | null): boolean => {
      if (!query.status) return true;
      if (!facts) return false;
      if (query.status === "archived") return facts.archived;
      if (facts.archived) return false;
      if (query.status === "waiting") return facts.section === "stopped" || facts.section === "holding" || facts.section === "waiting";
      return facts.section === query.status;
    };
    const fromOk = (doc: Doc, facts: ThreadFacts | null): boolean => {
      if (!query.from) return true;
      if (doc.type === "thread") return query.from === "me" ? !!facts?.me : !!facts?.agent;
      return doc.from === query.from;
    };
    const admit = (doc: Doc): { group: InboxSearchGroupId; facts: ThreadFacts | null } | null => {
      if (query.project && doc.projectId !== query.project) return null;
      let group: InboxSearchGroupId;
      switch (doc.type) {
        case "thread":
          group = "threads";
          break;
        case "message":
          group = "messages";
          break;
        case "file":
        case "guide":
          group = "files";
          break;
        case "decision":
          group = "decisions";
          break;
        case "project":
          // A project has no section and no author: any Status or From hides it.
          if (query.status || query.from) return null;
          return { group: "projects", facts: null };
      }
      // A decision recorded from no thread (an agent's record_decision) has no section.
      if (doc.type === "decision" && !doc.threadId) return query.status ? null : fromOk(doc, null) ? { group, facts: null } : null;
      const facts = doc.threadId ? this.factsOf(doc.threadId) : null;
      if (doc.threadId && !facts) return null;
      if (!statusOk(facts) || !fromOk(doc, facts)) return null;
      return { group, facts };
    };
    const score = (tier: number, title: boolean, archived: boolean, current: boolean, at: number): number =>
      ((((tier * 2 + (title ? 1 : 0)) * 2 + (archived ? 0 : 1)) * 2 + (current ? 1 : 0)) * 1e13) + Math.max(0, Math.min(at, 9.99e12));

    if (terms.length === 0) {
      // Filters with no words: the matching threads, newest first.
      for (const [key, number] of this.byKey) {
        if (!key.startsWith("t:")) continue;
        const doc = this.docs[number]!;
        const admitted = admit(doc);
        if (!admitted) continue;
        groups.threads.push({ doc: number, score: doc.at });
      }
    } else {
      for (const hit of this.match(terms)) {
        const doc = this.docs[hit.doc]!;
        const admitted = admit(doc);
        if (!admitted) continue;
        const archived = admitted.facts?.archived ?? (doc.type === "decision" ? this.store.decision(doc.ref)?.state !== "current" : false);
        groups[admitted.group].push({ doc: hit.doc, score: score(hit.tier, hit.title, archived, !!query.current && doc.projectId === query.current, doc.at) });
      }
    }
    const totals = {} as Record<InboxSearchGroupId, number>;
    const answer: Partial<Record<InboxSearchGroupId, InboxSearchRow[]>> = {};
    for (const id of INBOX_SEARCH_GROUPS) {
      const list = groups[id];
      totals[id] = list.length;
      if (query.group && query.group !== id) continue;
      if (terms.length === 0 && id !== "threads") continue;
      const limit = Math.min(INBOX_SEARCH_LIMIT_MAX, query.limit ?? (query.group ? INBOX_SEARCH_LIMIT_MAX : terms.length === 0 ? INBOX_SEARCH_BROWSE_LIMIT : INBOX_SEARCH_CAPS[id]));
      const offset = query.group ? Math.max(0, query.offset ?? 0) : 0;
      const rows: InboxSearchRow[] = [];
      for (const { doc } of topOf(list, offset + limit).slice(offset, offset + limit)) {
        const row = this.row(this.docs[doc]!, terms, labels);
        if (row) rows.push(row);
      }
      answer[id] = rows;
    }
    return { ...base, took_ms: this.now() - started, totals, groups: answer, recent: null };
  }

  /** The threads the person looked at last (`person_seen_seq`), newest look first. */
  private recentThreads(labels: Map<string, InboxSearchProjectRef>): InboxSearchThreadRow[] {
    const looked: { id: string; seq: number }[] = [];
    for (const id of this.store.threadIds()) {
      const seq = this.store.message(id)?.person_seen_seq;
      if (typeof seq === "number") looked.push({ id, seq });
    }
    looked.sort((a, b) => b.seq - a.seq);
    const out: InboxSearchThreadRow[] = [];
    for (const { id } of looked.slice(0, INBOX_SEARCH_RECENT_THREADS)) {
      const facts = this.factsOf(id);
      const root = this.store.message(id);
      if (!facts || !root) continue;
      out.push({
        type: "thread",
        id,
        thread_id: id,
        project: labels.get(facts.projectId) ?? { id: facts.projectId, name: "" },
        title: facts.subject || "(no subject)",
        title_marks: [],
        thread_name: facts.threadName,
        section: facts.section,
        archived: facts.archived,
        at: facts.lastAt,
      });
    }
    return out;
  }

  /** A result row as the window draws it, with marks only in the fields that matched. */
  private row(doc: Doc, terms: readonly string[], labels: Map<string, InboxSearchProjectRef>): InboxSearchRow | null {
    const project = labels.get(doc.projectId) ?? { id: doc.projectId, name: "" };
    const facts = doc.threadId ? this.factsOf(doc.threadId) : null;
    const where = { project, section: facts?.section ?? null, archived: facts?.archived ?? false };
    switch (doc.type) {
      case "thread": {
        if (!facts) return null;
        const title = facts.subject || "(no subject)";
        return { type: "thread", id: doc.ref, thread_id: doc.ref, ...where, title, title_marks: toMarks(inboxSearchRanges(title, terms)), thread_name: facts.threadName, at: facts.lastAt };
      }
      case "message": {
        const message = this.store.message(doc.ref);
        if (!message || !facts) return null;
        const best = this.bestMessageText(message, terms);
        return {
          type: "message",
          id: message.id,
          thread_id: message.thread_id,
          ...where,
          author: message.author.kind === "agent" ? { kind: "agent", name: inboxAgentName(message.author) } : { kind: "me", name: "You" },
          title: facts.subject || "(no subject)",
          snippet: inboxSearchSnippet(best.text, inboxSearchRanges(best.text, terms)),
          question: best.question,
          at: message.created_at,
        };
      }
      case "file": {
        const hit = this.store.attachment(doc.ref);
        if (!hit || !facts) return null;
        const name = hit.attachment.name;
        return {
          type: "file",
          id: hit.attachment.id,
          thread_id: hit.message.thread_id,
          message_id: hit.message.id,
          ...where,
          name,
          name_marks: toMarks(inboxSearchRanges(name, terms)),
          folder: fileFolder(hit.attachment.path),
          kind: fileKind(hit.attachment.kind, name),
          title: facts.subject || "(no subject)",
          at: hit.message.created_at,
        };
      }
      case "guide": {
        const message = this.store.message(doc.ref);
        if (!message?.guide || !facts) return null;
        const name = message.guide.title;
        return {
          type: "guide",
          id: message.id,
          thread_id: message.thread_id,
          message_id: message.id,
          ...where,
          name,
          name_marks: toMarks(inboxSearchRanges(name, terms)),
          folder: null,
          kind: "guide",
          title: facts.subject || "(no subject)",
          at: message.created_at,
        };
      }
      case "decision": {
        const decision = this.store.decision(doc.ref);
        if (!decision) return null;
        return {
          type: "decision",
          id: decision.id,
          ...where,
          archived: decision.state !== "current",
          text: decision.text,
          text_marks: toMarks(inboxSearchRanges(decision.text, terms)),
          state: decision.state,
          from: decision.source.kind === "agent" ? "agent" : "me",
          at: decision.changed_at ?? decision.created_at,
        };
      }
      case "project": {
        const record = this.store.project(doc.ref);
        if (!record) return null;
        return { type: "project", id: record.id, project, name: project.name, name_marks: toMarks(inboxSearchRanges(project.name, terms)), root: record.root, at: record.created_at };
      }
    }
  }

  /**
   * The text a message row shows: the field holding every term (the body,
   * else a question's prompt, its prompt with a choice or the answer, its
   * context), else the field holding the most of them.
   */
  private bestMessageText(message: InboxMessage, terms: readonly string[]): { text: string; question: { key: string; replaced: boolean } | null } {
    const candidates: { text: string; question: { key: string; replaced: boolean } | null }[] = [];
    if (message.author.kind === "person") candidates.push({ text: inboxSearchReplyText(message.body), question: null });
    else {
      candidates.push({ text: inboxSearchBodyText(message.body), question: null });
      for (const q of this.store.questionsOf(message.id)) {
        const ref = { key: q.key, replaced: q.state === "superseded" };
        const answer = answerText(q.answer);
        candidates.push({ text: q.prompt, question: ref });
        if (answer) candidates.push({ text: `${q.prompt} → ${answer}`, question: ref });
        for (const choice of q.choices) candidates.push({ text: `${q.prompt} → ${choice.label}`, question: ref });
        if (q.context) candidates.push({ text: q.context, question: ref });
      }
      candidates.push({ text: inboxAgentName(message.author), question: null });
    }
    let best = candidates[0]!;
    let bestCount = -1;
    for (const candidate of candidates) {
      if (!candidate.text) continue;
      const tokens = new Set(tokenizeInboxSearchText(candidate.text).map((t) => t.token));
      let count = 0;
      terms.forEach((term, i) => {
        if (tokens.has(term) || (i === terms.length - 1 && [...tokens].some((t) => t.startsWith(term)))) count += 1;
      });
      if (count === terms.length) return candidate;
      if (count > bestCount) {
        best = candidate;
        bestCount = count;
      }
    }
    return best;
  }
}

/** Any of the first `titleLen` tokens is a term (`termOf` non-zero). */
function scanTitle(bytes: Uint8Array, titleLen: number, termOf: Int32Array): boolean {
  let p = 0;
  for (let t = 0; t < titleLen; t++) {
    let id = bytes[p++]!;
    if (id & 0x80) {
      id &= 0x7f;
      let shift = 7;
      let b: number;
      do {
        b = bytes[p++]!;
        id |= (b & 0x7f) << shift;
        shift += 7;
      } while (b & 0x80);
    }
    if (termOf[id] !== 0) return true;
  }
  return false;
}

/**
 * One pass over a document's tokens for several terms. `termOf[id]` holds,
 * as bits, the terms a token matches (the last term's bit on every token it
 * prefixes). `run` holds which prefixes of the query end at the current
 * token, so a phrase is found without looking ahead. Returns -1 when a term
 * is missing, else the tier (3 phrase, 2 every term whole, 1 the last as a
 * prefix) plus 4 when the title fields hold every term.
 */
function scanDocument(bytes: Uint8Array, titleLen: number, termOf: Int32Array, lastExact: number, lastBit: number, all: number): number {
  const length = bytes.length;
  let seen = 0;
  let seenTitle = 0;
  let whole = false;
  let phrase = false;
  let run = 0;
  let p = 0;
  let t = 0;
  while (p < length) {
    let id = bytes[p++]!;
    if (id & 0x80) {
      id &= 0x7f;
      let shift = 7;
      let b: number;
      do {
        b = bytes[p++]!;
        id |= (b & 0x7f) << shift;
        shift += 7;
      } while (b & 0x80);
    }
    const m = termOf[id]!;
    run = ((run << 1) | 1) & m;
    if (m !== 0) {
      seen |= m;
      if (t < titleLen) seenTitle |= m;
      if (id === lastExact) whole = true;
      if ((run & lastBit) !== 0) phrase = true;
    }
    t++;
    if (phrase && whole && t >= titleLen && seen === all) break;
  }
  if (seen !== all) return -1;
  return (phrase ? 3 : whole ? 2 : 1) | (seenTitle === all ? 4 : 0);
}

/** The best `k` hits, best first (ties: the older document first, so the order is total). A partial selection when `k` is small. */
function topOf(list: { doc: number; score: number }[], k: number): { doc: number; score: number }[] {
  const better = (a: { doc: number; score: number }, b: { doc: number; score: number }) => b.score - a.score || a.doc - b.doc;
  if (k > 64 || list.length <= k * 4) return list.sort(better).slice(0, k);
  const best: { doc: number; score: number }[] = [];
  for (const hit of list) {
    if (best.length === k && better(hit, best[k - 1]!) >= 0) continue;
    let i = best.length === k ? k - 1 : best.length;
    if (best.length < k) best.push(hit);
    while (i > 0 && better(hit, best[i - 1]!) < 0) {
      best[i] = best[i - 1]!;
      i--;
    }
    best[i] = hit;
  }
  return best;
}

function questionTexts(question: InboxQuestion): string[] {
  return [question.prompt, question.context ?? "", ...question.choices.map((c) => c.label), answerText(question.answer)].filter(Boolean);
}

/** The kind chip: the file's extension (`md`, `pdf`, `png`, `log`), else its kind. */
function fileKind(kind: string, name: string): string {
  const extension = extensionOf(name);
  if (extension !== "file") return extension;
  return kind === "markdown" ? "md" : kind;
}

/**
 * Project names as the person reads them: the store's names (`inboxProjectLabels`:
 * the folder's real name, with its parent folder when two match), never the slug.
 */
export function projectLabels(projects: readonly InboxProject[]): Map<string, InboxSearchProjectRef> {
  return new Map(projects.map((project) => [project.id, { id: project.id, name: project.name }]));
}

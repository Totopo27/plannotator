/**
 * Inbox search's vocabulary and postings, sized for text full of hashes, ids,
 * timestamps and one-off words (the index is packages/shared/inbox/search.ts).
 *
 * A distinct word costs memory however rarely it occurs, so per word there
 * are only a few typed-array slots (about 40 bytes in all) and no object:
 *
 * - **Word text lives in one byte pool.** A plain-ASCII word of up to 254
 *   characters is its bytes in one growing Uint8Array, found by an offset and
 *   a length; only a word with a character outside ASCII (or a longer one)
 *   keeps a JavaScript string.
 * - **ID-like tokens share buckets.** A token that reads as an identifier
 *   (`isIdLikeToken`: 8 or more hex characters with digits and letters, such
 *   as commit hashes and UUID parts; more than 8 digits, such as timestamps;
 *   16 or more characters with 3 or more digits mixed through it, such as ULIDs and base32 or
 *   base64 ids) is not a word of its own: it is posted under one of
 *   `ID_BUCKETS` shared ids by its hash. A query term that reads as an id
 *   looks up its bucket, and the index checks each candidate's text for the
 *   term itself (`isBucket`), so an id is found by its whole value, never by a
 *   prefix of it.
 * - **Postings share one arena.** Each id keeps its first document, its count
 *   and its first block; a word seen in one document has nothing else. Later
 *   documents are delta varints in blocks of one arena, growing from 8 to
 *   1,024 bytes and chained per id; the first block's header also holds the
 *   last block and the last document.
 * - **The last term's prefix** is found through the words sharing its first
 *   two characters (`byPrefix`), then checked byte by byte, instead of a
 *   sorted copy of the vocabulary.
 *
 * Ids: 0 separates fields; words and buckets get ids in the order they are
 * first seen, so the common words, seen first, keep one-byte varints.
 */

/** How many shared ids the id-like tokens hash into. */
export const ID_BUCKETS = 8192;

/** Arrays grow by half again, not double: the slack is memory too. */
function grownLength(current: number, need: number): number {
  return Math.max(need, Math.ceil(current * 1.5), 1024);
}

function growInt32(array: Int32Array<ArrayBuffer>, need: number, fill = 0): Int32Array<ArrayBuffer> {
  if (need <= array.length) return array;
  const grown = new Int32Array(grownLength(array.length, need));
  grown.set(array);
  if (fill !== 0) grown.fill(fill, array.length);
  return grown;
}

function growUint8(array: Uint8Array<ArrayBuffer>, need: number): Uint8Array<ArrayBuffer> {
  if (need <= array.length) return array;
  const grown = new Uint8Array(grownLength(array.length, need));
  grown.set(array);
  return grown;
}

function fnvString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * Whether a folded token reads as an identifier rather than a word: 8+ hex
 * characters with both digits and letters (`9fceb02d`, a UUID's parts), more
 * than 8 digits (`1760000000000`), or 16+ letters and digits with 3+ digits
 * that switch between letters and digits 3+ times (`01m4v7jerhr0y3xq…`, not
 * `configuration2026`).
 */
export function isIdLikeToken(token: string): boolean {
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    if (!((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7a))) return false;
  }
  return isIdLikeSpan(token, 0, token.length);
}

/** The same test over a span of ASCII letters and digits (as the tokenizer's ASCII scan hands it; upper case counts as lower). */
function isIdLikeSpan(text: string, start: number, end: number): boolean {
  const length = end - start;
  if (length < 8) return false;
  let digits = 0;
  let hex = true;
  let switches = 0;
  let wasDigit = false;
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i) | 0x20;
    const digit = c <= 0x39;
    if (digit) digits += 1;
    else if (c > 0x66) hex = false;
    if (i > start && digit !== wasDigit) switches += 1;
    wasDigit = digit;
  }
  if (digits === length) return length > 8;
  if (hex && digits > 0) return true;
  return length >= 16 && digits >= 3 && switches >= 3;
}

/** `length` 0 marks a bucket (no word is empty); `RICH` a word kept as a string. */
const RICH = 255;

/** Old-table slots moved per new word while the word table grows. */
const MIGRATE_PER_WORD = 8;

export class Vocabulary {
  /** Next free id (0 is the field separator). */
  size = 1;
  private pool = new Uint8Array(1 << 16);
  private poolLength = 0;
  /** Per id: the pooled word's offset, `-1 - i` for `rich[i]`, a bucket's number. */
  private start = new Int32Array(1024);
  /** Per id: the pooled word's length, 0 for a bucket, `RICH` for a string. */
  private length = new Uint8Array(1024);
  private rich: string[] = [];
  private slots = new Int32Array(1 << 16);
  /** The table before the last growth, while its words move across (`grow`). */
  private old: Int32Array | null = null;
  private oldCursor = 0;
  private words = 0;
  /** Bucket number -> id (0: not seen yet). */
  private buckets = new Int32Array(ID_BUCKETS);
  /** Word ids by their first two UTF-16 units (the first alone for a one-unit word), and how many of each list are used. */
  private byPrefix = new Map<number, Int32Array>();
  private byPrefixUsed = new Map<number, number>();

  /** Distinct words (buckets excluded). */
  count(): number {
    return this.words;
  }

  /** Buckets in use. */
  bucketCount(): number {
    return this.size - 1 - this.words;
  }

  isBucket(id: number): boolean {
    return id > 0 && id < this.size && this.length[id] === 0;
  }

  private hashOf(id: number): number {
    if (this.length[id] === RICH) return fnvString(this.rich[-1 - this.start[id]!]!);
    let h = 0x811c9dc5;
    const start = this.start[id]!;
    const end = start + this.length[id]!;
    for (let i = start; i < end; i++) h = Math.imul(h ^ this.pool[i]!, 0x01000193);
    return h >>> 0;
  }

  private sameAsString(id: number, token: string): boolean {
    const length = this.length[id]!;
    if (length === RICH) return this.rich[-1 - this.start[id]!] === token;
    if (length !== token.length) return false;
    const start = this.start[id]!;
    for (let i = 0; i < length; i++) if (this.pool[start + i] !== token.charCodeAt(i)) return false;
    return true;
  }

  private bucketId(hash: number, create: boolean): number {
    const bucket = hash % ID_BUCKETS;
    const known = this.buckets[bucket]!;
    if (known !== 0) return known;
    if (!create) return -1;
    const id = this.newId();
    this.start[id] = bucket;
    this.length[id] = 0;
    this.buckets[bucket] = id;
    return id;
  }

  private newId(): number {
    const id = this.size++;
    this.start = growInt32(this.start, id + 1);
    this.length = growUint8(this.length, id + 1);
    return id;
  }

  /** A folded token's id in one table, or -1. */
  private probeString(table: Int32Array, token: string, h: number): number {
    const mask = table.length - 1;
    for (let i = h & mask; ; i = (i + 1) & mask) {
      const slot = table[i]!;
      if (slot === 0) return -1;
      if (this.sameAsString(slot, token)) return slot;
    }
  }

  /** The ASCII span's id in one table, else `-1 - the empty slot` where it would go. */
  private probeSpan(table: Int32Array, text: string, start: number, end: number, upper: boolean, h: number): number {
    const mask = table.length - 1;
    const length = end - start;
    for (let i = h & mask; ; i = (i + 1) & mask) {
      const slot = table[i]!;
      if (slot === 0) return -1 - i;
      if (this.length[slot] !== length) continue;
      const at = this.start[slot]!;
      let same = true;
      for (let k = 0; k < length; k++) {
        let c = text.charCodeAt(start + k);
        if (upper && c >= 0x41 && c <= 0x5a) c += 0x20;
        if (this.pool[at + k] !== c) {
          same = false;
          break;
        }
      }
      if (same) return slot;
    }
  }

  /** The id of a folded token (its bucket for an id-like one), or -1 for one never seen. */
  idOf(token: string): number {
    const h = fnvString(token);
    if (isIdLikeToken(token)) return this.bucketId(h, false);
    const id = this.probeString(this.slots, token, h);
    if (id >= 0 || !this.old) return id;
    return this.probeString(this.old, token, h);
  }

  /** The id of the ASCII token `text[start, end)` (lower-cased when `upper`), added when new. */
  idOfSpan(text: string, start: number, end: number, upper: boolean): number {
    let h = 0x811c9dc5;
    for (let k = start; k < end; k++) {
      let c = text.charCodeAt(k);
      if (upper && c >= 0x41 && c <= 0x5a) c += 0x20;
      h = Math.imul(h ^ c, 0x01000193);
    }
    h >>>= 0;
    if (isIdLikeSpan(text, start, end)) return this.bucketId(h, true);
    const length = end - start;
    if (length >= RICH) {
      const raw = text.slice(start, end);
      return this.idOfToken(upper ? raw.toLowerCase() : raw);
    }
    const found = this.probeSpan(this.slots, text, start, end, upper, h);
    if (found >= 0) return found;
    if (this.old) {
      const before = this.probeSpan(this.old, text, start, end, upper, h);
      if (before >= 0) return before;
    }
    const i = -1 - found;
    this.pool = growUint8(this.pool, this.poolLength + length);
    const at = this.poolLength;
    for (let k = 0; k < length; k++) {
      let c = text.charCodeAt(start + k);
      if (upper && c >= 0x41 && c <= 0x5a) c += 0x20;
      this.pool[at + k] = c;
    }
    this.poolLength += length;
    const id = this.newId();
    this.start[id] = at;
    this.length[id] = length;
    this.placeWord(id, i, this.pool[at]!, length > 1 ? this.pool[at + 1]! : -1);
    return id;
  }

  /** The id of a folded token, added when new (its bucket for an id-like one). */
  idOfToken(token: string): number {
    const known = this.idOf(token);
    if (known >= 0) return known;
    const h = fnvString(token);
    if (isIdLikeToken(token)) return this.bucketId(h, true);
    let ascii = token.length < RICH;
    for (let i = 0; ascii && i < token.length; i++) if (token.charCodeAt(i) > 0x7f) ascii = false;
    if (ascii) return this.idOfSpan(token, 0, token.length, false);
    this.rich.push(token);
    const id = this.newId();
    this.start[id] = -this.rich.length;
    this.length[id] = RICH;
    const mask = this.slots.length - 1;
    let i = h & mask;
    while (this.slots[i] !== 0) i = (i + 1) & mask;
    this.placeWord(id, i, token.charCodeAt(0), token.length > 1 ? token.charCodeAt(1) : -1);
    return id;
  }

  /** Put a new word in slot `slot` and in its prefix list. */
  private placeWord(id: number, slot: number, c0: number, c1: number): void {
    this.slots[slot] = id;
    this.words += 1;
    if (this.old) this.migrate(MIGRATE_PER_WORD);
    if (this.words * 10 > this.slots.length * 7) this.grow();
    const key = c0 * 65537 + (c1 + 1);
    let list = this.byPrefix.get(key);
    const used = this.byPrefixUsed.get(key) ?? 0;
    if (!list || used === list.length) {
      const grown = new Int32Array(list ? Math.ceil(list.length * 1.5) + 1 : 2);
      if (list) grown.set(list);
      list = grown;
      this.byPrefix.set(key, list);
    }
    list[used] = id;
    this.byPrefixUsed.set(key, used + 1);
  }

  /**
   * A table twice the size. The full one stays readable as `old` and moves
   * across a few slots per new word (`migrate`), so no single insert pays
   * for a million words (a rehash of 1.4 million took 20 ms, past a build
   * slice's 8 ms). It is done long before the new table fills: the new
   * table takes 0.7 of the old size in new words before it grows again, and
   * every new word moves `MIGRATE_PER_WORD` slots of the old one.
   */
  private grow(): void {
    if (this.old) this.migrate(Infinity);
    this.old = this.slots;
    this.oldCursor = 0;
    this.slots = new Int32Array(this.slots.length * 2);
  }

  private migrate(count: number): void {
    const old = this.old!;
    const slots = this.slots;
    const mask = slots.length - 1;
    const end = Math.min(old.length, this.oldCursor + count);
    for (let k = this.oldCursor; k < end; k++) {
      const id = old[k]!;
      if (id === 0) continue;
      let i = this.hashOf(id) & mask;
      while (slots[i] !== 0) i = (i + 1) & mask;
      slots[i] = id;
    }
    this.oldCursor = end;
    if (end === old.length) this.old = null;
  }

  /** The word's text ("" for a bucket). */
  word(id: number): string {
    const length = this.length[id]!;
    if (length === 0) return "";
    if (length === RICH) return this.rich[-1 - this.start[id]!]!;
    let out = "";
    const start = this.start[id]!;
    for (let i = start; i < start + length; i++) out += String.fromCharCode(this.pool[i]!);
    return out;
  }

  private startsWith(id: number, prefix: string): boolean {
    const length = this.length[id]!;
    if (length === RICH) return this.rich[-1 - this.start[id]!]!.startsWith(prefix);
    if (length < prefix.length) return false;
    const start = this.start[id]!;
    for (let i = 0; i < prefix.length; i++) if (this.pool[start + i] !== prefix.charCodeAt(i)) return false;
    return true;
  }

  /** The ids a last term matches as a prefix: the words starting with it; for an id-like term, its bucket alone. */
  prefixIds(prefix: string): number[] {
    if (prefix.length === 0) return [];
    if (isIdLikeToken(prefix)) {
      const id = this.bucketId(fnvString(prefix), false);
      return id < 0 ? [] : [id];
    }
    const out: number[] = [];
    const scan = (key: number) => {
      const list = this.byPrefix.get(key);
      if (!list) return;
      const used = this.byPrefixUsed.get(key)!;
      for (let i = 0; i < used; i++) if (this.startsWith(list[i]!, prefix)) out.push(list[i]!);
    };
    const c0 = prefix.charCodeAt(0);
    if (prefix.length >= 2) scan(c0 * 65537 + (prefix.charCodeAt(1) + 1));
    else for (const key of this.byPrefix.keys()) if (Math.floor(key / 65537) === c0) scan(key);
    return out;
  }

  /** Give back the growth slack (after a build; later growth starts again from the trimmed size). */
  compact(): void {
    this.pool = this.pool.slice(0, this.poolLength);
    this.start = this.start.slice(0, this.size);
    this.length = this.length.slice(0, this.size);
    for (const [key, list] of this.byPrefix) {
      const used = this.byPrefixUsed.get(key)!;
      if (used < list.length) this.byPrefix.set(key, list.slice(0, used));
    }
  }

  /** Bytes held (capacity, not use: the slack is memory too). */
  bytes(): number {
    let prefixes = 0;
    for (const list of this.byPrefix.values()) prefixes += list.byteLength + 96;
    let rich = 0;
    for (const word of this.rich) rich += 24 + word.length * 2;
    return this.pool.byteLength + this.start.byteLength + this.length.byteLength + this.buckets.byteLength + this.slots.byteLength + prefixes + rich;
  }
}

/**
 * Arena block header. Every block: the next block, its capacity, the bytes
 * used. The first block of an id also: its last block, its last document,
 * its first document and its count.
 */
const HEADER = 24;
const NEXT = 0;
const CAPACITY = 4;
const USED = 6;
const TAIL = 8;
const LAST = 12;
const FIRST = 16;
const COUNT = 20;

/** `slot` value of an id with no document. */
const NONE = -1;

/**
 * Each id's documents, in increasing document order, in one Int32 per id: a
 * single document is the value itself; more are a block of the shared arena
 * (`-2 - offset`), delta varints chained from it.
 */
export class Postings {
  private slot = new Int32Array(1024).fill(NONE);
  private size = 0;
  private arena = new Uint8Array(1 << 16);
  private view = new DataView(this.arena.buffer);
  private arenaLength = 0;

  count(id: number): number {
    if (id >= this.size) return 0;
    const v = this.slot[id]!;
    if (v === NONE) return 0;
    if (v >= 0) return 1;
    return this.view.getInt32(-2 - v + COUNT, true);
  }

  private block(capacity: number): number {
    const need = HEADER + capacity;
    if (this.arenaLength + need > this.arena.length) {
      this.arena = growUint8(this.arena, this.arenaLength + need);
      this.view = new DataView(this.arena.buffer);
    }
    const at = this.arenaLength;
    this.view.setInt32(at + NEXT, -1, true);
    this.view.setUint16(at + CAPACITY, capacity, true);
    this.view.setUint16(at + USED, 0, true);
    this.arenaLength += need;
    return at;
  }

  /** Post `doc` (no smaller than any before) under `id`; a document already last under it is skipped (a word twice in one document). */
  add(id: number, doc: number): void {
    if (id >= this.slot.length) this.slot = growInt32(this.slot, id + 1, NONE);
    if (id >= this.size) this.size = id + 1;
    const v = this.slot[id]!;
    if (v === NONE) {
      this.slot[id] = doc;
      return;
    }
    let head: number;
    let last: number;
    if (v >= 0) {
      if (v === doc) return;
      head = this.block(8);
      this.view.setInt32(head + TAIL, head, true);
      this.view.setInt32(head + FIRST, v, true);
      this.view.setInt32(head + COUNT, 1, true);
      this.slot[id] = -2 - head;
      last = v;
    } else {
      head = -2 - v;
      last = this.view.getInt32(head + LAST, true);
      if (last === doc) return;
    }
    let delta = doc - last;
    let tail = this.view.getInt32(head + TAIL, true);
    let used = this.view.getUint16(tail + USED, true);
    const capacity = this.view.getUint16(tail + CAPACITY, true);
    if (used + 5 > capacity) {
      const next = this.block(Math.min(1024, capacity * 2));
      this.view.setInt32(tail + NEXT, next, true);
      this.view.setInt32(head + TAIL, next, true);
      tail = next;
      used = 0;
    }
    const arena = this.arena;
    let p = tail + HEADER + used;
    while (delta >= 0x80) {
      arena[p++] = (delta & 0x7f) | 0x80;
      delta >>>= 7;
    }
    arena[p++] = delta;
    this.view.setUint16(tail + USED, p - tail - HEADER, true);
    this.view.setInt32(head + LAST, doc, true);
    this.view.setInt32(head + COUNT, this.view.getInt32(head + COUNT, true) + 1, true);
  }

  /** The documents under `id`, in increasing order. */
  list(id: number): Int32Array {
    const n = this.count(id);
    const out = new Int32Array(n);
    if (n === 0) return out;
    const v = this.slot[id]!;
    if (v >= 0) {
      out[0] = v;
      return out;
    }
    const arena = this.arena;
    const view = this.view;
    let doc = view.getInt32(-2 - v + FIRST, true);
    out[0] = doc;
    let k = 1;
    for (let at = -2 - v; at >= 0 && k < n; at = view.getInt32(at + NEXT, true)) {
      let p = at + HEADER;
      const end = p + view.getUint16(at + USED, true);
      while (p < end) {
        let value = arena[p++]!;
        if (value & 0x80) {
          value &= 0x7f;
          let shift = 7;
          let b: number;
          do {
            b = arena[p++]!;
            value |= (b & 0x7f) << shift;
            shift += 7;
          } while (b & 0x80);
        }
        doc += value;
        out[k++] = doc;
      }
    }
    return out;
  }

  /** Give back the growth slack (after a build; later growth starts again from the trimmed size). */
  compact(): void {
    this.slot = this.slot.slice(0, this.size);
    this.arena = this.arena.slice(0, this.arenaLength);
    this.view = new DataView(this.arena.buffer);
  }

  /** Bytes held (capacity). */
  bytes(): number {
    return this.arena.byteLength + this.slot.byteLength;
  }
}

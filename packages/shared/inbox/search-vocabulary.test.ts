/**
 * The search index's vocabulary and postings (search-vocabulary.ts): which
 * tokens read as ids and share buckets, word lookup from a string and from a
 * span of text, prefixes (two-character lists, one-character and non-ASCII
 * prefixes, growth past a rehash), and postings in the shared arena (a word
 * in one document, in thousands, a word twice in one document) against a
 * plain model.
 */
import { describe, expect, test } from "bun:test";
import { ID_BUCKETS, isIdLikeToken, Postings, Vocabulary } from "./search-vocabulary";

describe("id-like tokens", () => {
  test("hashes, long numbers, ULIDs and UUID parts are ids; words, short numbers and short hex words are not", () => {
    for (const token of [
      "3f2a9c1e",
      "9fceb02d0ae598e95dc970b74767f19372d61af8",
      "1760000000000",
      "123456789",
      "01m4v7jerhr0y3xqerk1mr604e",
      "550e8400",
      "446655440000",
    ])
      expect([token, isIdLikeToken(token)]).toEqual([token, true]);
    for (const token of ["relay", "deadbeef", "facade", "12345678", "2026", "pagination", "tokenizer", "abc12345x", "configuration2026", "naïve"])
      expect([token, isIdLikeToken(token)]).toEqual([token, false]);
  });

  test("an id-like token is a shared bucket id; a span of the same id finds the same bucket, upper case included", () => {
    const vocab = new Vocabulary();
    const hash = "9fceb02d0ae598e95dc970b74767f19372d61af8";
    const text = `commit ${hash.toUpperCase()} landed`;
    const fromSpan = vocab.idOfSpan(text, 7, 7 + hash.length, true);
    expect(vocab.isBucket(fromSpan)).toBe(true);
    expect(vocab.idOf(hash)).toBe(fromSpan);
    expect(vocab.count()).toBe(0);
    expect(vocab.bucketCount()).toBe(1);
    // Its prefix is not a word, and the whole id answers only its bucket.
    expect(vocab.prefixIds("9fceb02")).toEqual([]);
    expect(vocab.prefixIds(hash)).toEqual([fromSpan]);
    // Never more buckets than ID_BUCKETS, however many ids.
    for (let i = 0; i < 40_000; i++) vocab.idOfToken(`${(i * 2654435761 >>> 0).toString(16).padStart(8, "0")}${i}`);
    expect(vocab.bucketCount()).toBeLessThanOrEqual(ID_BUCKETS);
    expect(vocab.count()).toBe(0);
  });
});

describe("words", () => {
  test("a word from a string and from a span of text is one id; a word never seen is -1", () => {
    const vocab = new Vocabulary();
    const a = vocab.idOfToken("relay");
    expect(vocab.idOfSpan("The Relay brakes", 4, 9, true)).toBe(a);
    expect(vocab.idOf("relay")).toBe(a);
    expect(vocab.idOf("relays")).toBe(-1);
    expect(vocab.word(a)).toBe("relay");
    const rich = vocab.idOfToken("naïve");
    expect(vocab.idOf("naïve")).toBe(rich);
    expect(vocab.word(rich)).toBe("naïve");
    expect(vocab.isBucket(a)).toBe(false);
  });

  test("100,000 words through several table growths: every id found again, while a growth moves words across and after; every prefix complete", () => {
    const vocab = new Vocabulary();
    const words = new Map<string, number>();
    const order: string[] = [];
    let seed = 7;
    const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
    const letters = "abcdefghijklmnopqrstuvwxyz";
    while (words.size < 100_000) {
      const word = Array.from({ length: 2 + Math.floor(random() * 9) }, () => letters[Math.floor(random() * 26)]).join("");
      if (words.has(word)) continue;
      // A word seen before is found again from a string and from a span, never added twice.
      if (order.length > 0 && words.size % 97 === 0) {
        const earlier = order[Math.floor(random() * order.length)]!;
        expect(vocab.idOfToken(earlier)).toBe(words.get(earlier)!);
        expect(vocab.idOfSpan(` ${earlier.toUpperCase()} `, 1, 1 + earlier.length, true)).toBe(words.get(earlier)!);
      }
      words.set(word, vocab.idOfToken(word));
      order.push(word);
    }
    for (const word of ["東京", "東京都", "مرحبا", "été"]) words.set(word, vocab.idOfToken(word));
    expect(vocab.count()).toBe(words.size);
    for (const [word, id] of words) expect(vocab.idOf(word)).toBe(id);
    for (const prefix of ["q", "ab", "zz", "rel", "xyzq", "東", "東京", "مر", "é"]) {
      const expected = [...words].filter(([word]) => word.startsWith(prefix)).map(([, id]) => id).sort((a, b) => a - b);
      expect([prefix, vocab.prefixIds(prefix).sort((a, b) => a - b)]).toEqual([prefix, expected]);
    }
  });
});

describe("postings", () => {
  test("against a plain model: single documents with no block, long lists across blocks, repeats in one document skipped", () => {
    const postings = new Postings();
    const model = new Map<number, number[]>();
    let seed = 3;
    const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
    for (let doc = 0; doc < 20_000; doc += 1 + Math.floor(random() * 300)) {
      const tokens = Array.from({ length: 40 }, () => (random() < 0.5 ? 1 + Math.floor(random() * 5) : 6 + Math.floor(random() * 5000)));
      for (const id of tokens) {
        postings.add(id, doc);
        const list = model.get(id) ?? [];
        if (list[list.length - 1] !== doc) list.push(doc);
        model.set(id, list);
      }
    }
    for (const [id, list] of model) {
      expect(postings.count(id)).toBe(list.length);
      expect([...postings.list(id)]).toEqual(list);
    }
    expect(postings.count(999_999)).toBe(0);
    expect([...postings.list(999_999)]).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import { check, wrapLikeGitHub } from './check-commit-message.mjs';

describe('check-commit-message: will release-please drop this PR?', () => {
  it('accepts an ordinary description', () => {
    const r = check('fix: a thing', 'Explains the thing.\n\n- a list item\n- another (with parentheses)\n\n| a | b |\n| --- | --- |', 7);
    expect(r.failures).toEqual([]);
  });

  it('catches a code line that starts like a commit header — the case that dropped two fixes', () => {
    const body = 'What broke:\n```js\nproduce(intern([0]), d => { d.push(c); d[1].y = 2; });\n```\nDone.';
    const r = check('fix: lost edits on pushed elements', body, 18);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].error).toMatch(/unexpected token '\('/);
    expect(r.failures[0].line).toMatch(/^produce\(intern/);
    expect(r.matters).toBe(true);
  });

  it('catches a line start that only exists after GitHub re-wraps the description at 72 columns', () => {
    // 65 columns of words, so the next word cannot fit and starts a new line.
    const prefix = 'word '.repeat(13).trim();
    expect(prefix.length).toBe(64);
    const sentence = `${prefix} compute(first(x), y) and the rest of the sentence.`;
    expect(check('fix: a thing', sentence.replace('compute(first(x), y)', 'a plain phrase'), 1).failures).toEqual([]);
    const wrapped = wrapLikeGitHub(sentence).split('\n');
    expect(wrapped[1].startsWith('compute(first(')).toBe(true); // the premise of this test
    expect(check('fix: a thing', sentence, 1).failures).not.toEqual([]);
  });

  it('wraps like GitHub: greedy at 72 columns, fenced code left alone', () => {
    const long = 'word '.repeat(30).trim();
    expect(wrapLikeGitHub(long).split('\n').every((l) => l.length <= 72)).toBe(true);
    expect(wrapLikeGitHub('```\n' + long + '\n```')).toBe('```\n' + long + '\n```');
    expect(wrapLikeGitHub('short')).toBe('short');
  });

  it('an override block is all release-please reads, so the rest may say anything', () => {
    const body = 'produce(intern([0]), d => 1)\n\nBEGIN_COMMIT_OVERRIDE\nfix: the entry\nfix: a second entry\nEND_COMMIT_OVERRIDE\n';
    const r = check('fix: something', body, 3);
    expect(r).toMatchObject({ failures: [], overridden: true });
    // …but the override itself has to parse.
    expect(check('fix: something', 'BEGIN_COMMIT_OVERRIDE\nfoo(bar(baz), 1)\nEND_COMMIT_OVERRIDE', 3).failures).not.toEqual([]);
  });

  it('only matters for commits the changelog would show', () => {
    const bad = 'call(nested(1), 2)';
    expect(check('chore: bump things', bad, 1)).toMatchObject({ matters: false });
    expect(check('ci: tweak', bad, 1)).toMatchObject({ matters: false });
    expect(check('refactor: move code', bad, 1)).toMatchObject({ matters: false });
    for (const title of ['fix: x', 'feat: x', 'perf: x', 'revert: x', 'refactor!: x', 'feat(scope): x']) {
      expect(check(title, bad, 1)).toMatchObject({ matters: true });
    }
    expect(check('refactor: x', bad + '\n\nBREAKING CHANGE: it breaks', 1)).toMatchObject({ matters: true });
    expect(check('not conventional at all', bad, 1)).toMatchObject({ matters: true });
  });

  it('checks the endings GitHub may append: trailers, with or without the separator', () => {
    expect(check('fix: x', 'Body.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)', 9).failures).toEqual([]);
  });
});

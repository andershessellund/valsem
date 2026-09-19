// ---------------------------------------------------------------------------
// Will release-please be able to read this pull request?
//
// main takes squash merges, and the squash commit is the PR title plus the PR
// description. release-please parses that WHOLE message with a strict
// Conventional Commits grammar, and a commit it cannot parse is dropped from
// the changelog and from the version calculation — silently, with a line in a
// workflow log nobody reads. It happened to two real fixes: a description line
// such as `produce(intern([0]), …)` looks like a `type(scope)` header, and
// the nested parenthesis is a syntax error.
//
// This runs the same parser, at the same version, after the same two
// preprocessing steps (src/commit.ts in release-please), so it fails exactly
// when the commit would be dropped.
//
// Reads PR_TITLE, PR_BODY and PR_NUMBER from the environment.
// ---------------------------------------------------------------------------
import { parser } from '@conventional-commits/parser';

const TYPES = 'feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert';
/** Types release-please lists in the changelog. Dropping one of these loses release notes. */
const VISIBLE = new Set(['feat', 'fix', 'perf', 'revert', 'deps']);

/**
 * GitHub does not use the description verbatim in the squash commit: it
 * re-wraps each line at 72 columns, greedily on spaces, leaving fenced code
 * blocks alone. Wrapping creates new line starts, so a harmless mid-sentence
 * `name(` can become the start of a line and break the parser. Reproduced
 * here; verified byte-identical against the squash commits on main.
 */
export function wrapLikeGitHub(text, width = 72) {
  let fenced = false;
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced || line.length <= width) return line;
      const out = [];
      let current = '';
      for (const word of line.split(' ')) {
        if (current === '') current = word;
        else if (`${current} ${word}`.length <= width) current += ` ${word}`;
        else {
          out.push(current);
          current = word;
        }
      }
      out.push(current);
      return out.join('\n');
    })
    .join('\n');
}

/**
 * The messages release-please may end up parsing for this PR.
 *
 * An override block in the description replaces everything (release-please's
 * preprocessCommitMessage). Otherwise it is the squash commit: title, PR
 * number, the wrapped description, and the co-author trailers GitHub appends,
 * after a `---------` line when the PR has several commits. Which ending a PR
 * gets is not known yet, so both are checked.
 */
function candidateMessages(title, body, number) {
  const override = (body.split('BEGIN_COMMIT_OVERRIDE')[1] || '').split('END_COMMIT_OVERRIDE')[0].trim();
  if (override) return { messages: [override], overridden: true };
  const base = `${title} (#${number})\n\n${wrapLikeGitHub(body)}`.trim();
  const trailer = 'Co-authored-by: Someone <someone@example.com>';
  return { messages: [base, `${base}\n\n${trailer}`, `${base}\n\n---------\n\n${trailer}`], overridden: false };
}

/** release-please's splitMessages: a body may hold several conventional commits. */
function splitMessages(message) {
  const parts = message.split('BEGIN_NESTED_COMMIT');
  const messages = [parts.shift()];
  for (const part of parts) {
    const [nested, ...rest] = part.split('END_NESTED_COMMIT');
    messages.push(nested);
    messages[0] += rest.join('END_NESTED_COMMIT');
  }
  const split = messages[0].split(new RegExp(`\\r?\\n\\r?\\n(?=(?:${TYPES})(?:\\(.*?\\))?: )`)).filter(Boolean);
  return [...split, ...messages.slice(1)];
}

export function check(title, body, number) {
  const { messages, overridden } = candidateMessages(title, body ?? '', number);
  const failures = [];
  const seen = new Set();
  for (const message of messages) {
    for (const part of splitMessages(message)) {
      try {
        parser(part);
      } catch (error) {
        const at = /at (\d+):(\d+)/.exec(String(error.message));
        const line = at ? part.split(/\r?\n/)[Number(at[1]) - 1] : undefined;
        const key = `${error.message}|${line}`;
        if (!seen.has(key)) failures.push({ error: String(error.message), line });
        seen.add(key);
      }
    }
  }
  const type = /^(\w+)(?:\(.*?\))?(!)?:/.exec(title);
  const matters = overridden || !type || VISIBLE.has(type[1]) || type[2] === '!' || /BREAKING[ -]CHANGE/.test(body ?? '');
  return { failures, matters, overridden };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { PR_TITLE: title = '', PR_BODY: body = '', PR_NUMBER: number = '0' } = process.env;
  const { failures, matters, overridden } = check(title, body, number);
  if (failures.length === 0) {
    console.log(`ok: release-please can parse this${overridden ? ' (using the COMMIT_OVERRIDE block)' : ''}.`);
    process.exit(0);
  }
  for (const f of failures) {
    console.log(`release-please cannot parse this commit message: ${f.error}`);
    if (f.line !== undefined) console.log(`  the line: ${f.line}`);
  }
  if (!matters) {
    console.log(`\nNot fatal: a "${title.split(':')[0]}" commit is hidden from the changelog, so dropping it loses nothing.`);
    process.exit(0);
  }
  console.log(`
When release-please cannot parse a squash commit it DROPS it: no changelog
entry, and it does not count towards the next version. The message it parses
is this PR's title plus its description.

The usual cause is a description line that starts like a commit header, such
as a line of code beginning with name( and containing another parenthesis.

Fix it either way:
  - reword or indent the line shown above, or
  - add this to the PR description. release-please then reads ONLY what is
    between the markers, so the rest of the description can say anything:

      BEGIN_COMMIT_OVERRIDE
      fix: one line per changelog entry
      END_COMMIT_OVERRIDE
`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// draftOf() — detached drafts: a second root inside a recipe's scope.
//
// The recipe brings material in from elsewhere (another store, a signal read
// inside a computed), edits it before it has a slot, then attaches it. Every
// attachment route resolves the draft where it landed; unattached drafts are
// dropped; the lifetime is the scope's, like every other draft.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { produce, produceWithPatches, draftOf, isDraft } from './produce.js';
import { current, original } from './current.js';
import { intern } from './intern.js';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { ValueList } from './value-list.js';
import { ValueDate } from './value-date.js';
import { expectPatchRoundTrip } from './patches.test-helpers.js';
import { COLLECTIONS } from './roster.test-helpers.js';

interface Config {
  enabled: boolean;
  level: number;
}
interface State {
  config: Config;
  tags: string[];
  byId: ValueMap<string, Config>;
  list: ValueList<Config>;
  seen: ValueSet<Config>;
}

const config = intern<Config>({ enabled: false, level: 1 });
const other = intern<Config>({ enabled: false, level: 9 });
const base = intern<State>({
  config,
  tags: ['a'],
  byId: ValueMap.from<string, Config>([['x', config]]),
  list: ValueList.of(config),
  seen: ValueSet.from([config]),
});

describe('draftOf() — attaching', () => {
  it('assigned into a record slot', () => {
    const next = produce(base, (d) => {
      const c = draftOf(other);
      c.enabled = true;
      d.config = c;
    });
    expect(next.config).toBe(intern({ enabled: true, level: 9 }));
    expect(next.tags).toBe(base.tags);
  });

  it('pushed into an array, set into a map, a list and a set', () => {
    const edited = intern({ enabled: true, level: 9 });
    const next = produce(base, (d) => {
      const c = draftOf(other);
      c.enabled = true;
      d.tags.push('b');
      d.byId.set('y', c);
      d.list.push(c);
      d.seen.add(c);
    });
    expect(next.byId.get('y')).toBe(edited);
    expect(next.list.at(1)).toBe(edited);
    expect(next.seen.has(edited)).toBe(true);
    expect(next.tags).toEqual(['a', 'b']);
  });

  it('embedded in a grafted literal', () => {
    const next = produce(base, (d) => {
      const c = draftOf(other);
      c.level = 2;
      (d as unknown as { extra: unknown }).extra = { wrapped: [c] };
    });
    expect((next as unknown as { extra: { wrapped: Config[] } }).extra.wrapped[0]).toBe(
      intern({ enabled: false, level: 2 }),
    );
  });

  it('returned as the replacement', () => {
    const next = produce(base.config, () => {
      const c = draftOf(other);
      c.enabled = true;
      return c;
    });
    expect(next).toBe(intern({ enabled: true, level: 9 }));
  });

  it('a replacement plus a mutated root is still rejected', () => {
    expect(() =>
      produce(base, (d) => {
        d.tags.push('b');
        return draftOf(other) as unknown as State;
      }),
    ).toThrow(/mutate the draft or return a replacement/);
  });

  it('attached at several places resolves to one canonical instance', () => {
    const next = produce(base, (d) => {
      const c = draftOf(other);
      c.level = 3;
      d.config = c;
      d.byId.set('z', c);
      d.list.push(c);
    });
    expect(next.config).toBe(next.byId.get('z'));
    expect(next.config).toBe(next.list.at(1));
    expect(next.config).toBe(intern({ enabled: false, level: 3 }));
  });

  it('a value can be drafted, attached, and edited further through the slot', () => {
    const next = produce(base, (d) => {
      const c = draftOf(other);
      d.config = c;
      d.config.enabled = true; // reads back the same draft
      expect(d.config).toBe(c);
      c.level = 4;
    });
    expect(next.config).toBe(intern({ enabled: true, level: 4 }));
  });

  it.each(COLLECTIONS.map((c) => [c.name, c] as const))('%s drafts detached, and lands canonical where it is attached', (_name, c) => {
    const next = produce(base, (d) => {
      const detached = draftOf(c.of('a'));
      expect(detached).toBeInstanceOf(c.draftType);
      c.draftAdd(detached, { n: 1 });
      (d as unknown as { held: unknown }).held = detached;
    });
    expect((next as unknown as { held: unknown }).held).toBe(c.of('a', { n: 1 }));
  });

  it('collections draft detached too', () => {
    const next = produce(base, (d) => {
      const m = draftOf(ValueMap.from<string, number>([['k', 1]]));
      m.set('k', 2);
      (d as unknown as { m: unknown }).m = m;
      const l = draftOf(ValueList.of(1, 2));
      l.push(3);
      (d as unknown as { l: unknown }).l = l;
    });
    const n = next as unknown as { m: ValueMap<string, number>; l: ValueList<number> };
    expect(n.m).toBe(ValueMap.from([['k', 2]]));
    expect(n.l).toBe(ValueList.of(1, 2, 3));
  });
});

describe('draftOf() — convergence and detachment', () => {
  it('an unedited draft attached over its own base nets out', () => {
    const next = produce(base, (d) => {
      d.config = draftOf(config);
    });
    expect(next).toBe(base);
  });

  it('edits that net out converge on the base', () => {
    const next = produce(base, (d) => {
      const c = draftOf(config);
      c.enabled = true;
      c.enabled = false;
      d.config = c;
    });
    expect(next).toBe(base);
  });

  it('unattached drafts are dropped', () => {
    const next = produce(base, () => {
      const c = draftOf(config);
      c.enabled = true;
    });
    expect(next).toBe(base);
  });

  it('is independent of the child draft over the same base', () => {
    const next = produce(base, (d) => {
      const c = draftOf(base.config);
      c.level = 5;
      d.config.enabled = true;
      expect(c).not.toBe(d.config);
      expect(d.config.level).toBe(1);
    });
    expect(next.config).toBe(intern({ enabled: true, level: 1 }));
  });

  it('two drafts of one base are independent', () => {
    produce(base, () => {
      const a = draftOf(config);
      const b = draftOf(config);
      a.level = 7;
      expect(b.level).toBe(1);
      expect(a).not.toBe(b);
    });
  });

  it('does not mutate a foreign (unfrozen) base', () => {
    const raw = { enabled: false, level: 1 };
    const next = produce(base, (d) => {
      const c = draftOf(raw);
      c.enabled = true;
      d.config = c;
    });
    expect(raw).toEqual({ enabled: false, level: 1 });
    expect(next.config).toBe(intern({ enabled: true, level: 1 }));
  });
});

describe('draftOf() — patches and inspectors', () => {
  it('attaches as a whole-value patch with a restoring inverse', () => {
    const [next, patches, inverse] = produceWithPatches(base, (d) => {
      const c = draftOf(other);
      c.enabled = true;
      d.config = c;
    });
    expect(patches).toEqual([
      { kind: 'record.set', path: [], key: 'config', value: intern({ enabled: true, level: 9 }) },
    ]);
    expect(inverse).toEqual([{ kind: 'record.set', path: [], key: 'config', value: config }]);
    expectPatchRoundTrip(base, next, patches, inverse);
  });

  it('a returned draft is a root replace patch', () => {
    const [next, patches] = produceWithPatches(base.config, () => {
      const c = draftOf(other);
      c.level = 0;
      return c;
    });
    expect(patches).toEqual([{ kind: 'replace', path: [], value: next }]);
  });

  it('current() and original() work on a detached draft', () => {
    produce(base, () => {
      const c = draftOf(other);
      expect(original(c)).toBe(other);
      expect(current(c)).toBe(other);
      c.enabled = true;
      expect(current(c)).toBe(intern({ enabled: true, level: 9 }));
      expect(original(c)).toBe(other);
    });
  });
});

describe('draftOf() — guards', () => {
  it('throws outside a recipe', () => {
    expect(() => draftOf(config)).toThrow(/draftOf\(\) can only be called inside a produce\(\) recipe/);
  });

  it('returns non-draftables as themselves', () => {
    produce(base, () => {
      expect(draftOf(1)).toBe(1);
      expect(draftOf('s')).toBe('s');
      expect(draftOf(null)).toBe(null);
      expect(draftOf(undefined)).toBe(undefined);
      const date = ValueDate.from(new Date(0));
      expect(draftOf(date)).toBe(date);
    });
  });

  it('is idempotent on a draft of this scope', () => {
    produce(base, (d) => {
      const c = draftOf(other);
      expect(draftOf(c)).toBe(c);
      expect(draftOf(d)).toBe(d);
      expect(draftOf(d.config)).toBe(d.config);
      expect(draftOf(d.byId)).toBe(d.byId);
      expect(isDraft(c)).toBe(true);
    });
  });

  it('rejects a draft from another produce() call', () => {
    produce(base, (outer) => {
      expect(() => produce(config, () => draftOf(outer.config))).toThrow(/different produce\(\) call/);
    });
  });

  it('is revoked when the recipe ends', () => {
    let leaked: Config | undefined;
    let leakedMap: ValueMap<string, number> | undefined;
    produce(base, () => {
      leaked = draftOf(other);
      leakedMap = draftOf(ValueMap.from<string, number>([['k', 1]])) as unknown as ValueMap<string, number>;
    });
    expect(() => leaked!.level).toThrow(/revoked/);
    expect(() => leakedMap!.get('k')).toThrow(/escaped its produce\(\) call/);
  });

  it('returns the base draft type', () => {
    produce(base, () => {
      const c = draftOf(other);
      c.level = 2; // Draft<Config> is writable
      const m = draftOf(ValueMap.from<string, number>([['k', 1]]));
      m.set('k', 2); // Draft<ValueMap> is DraftMap
    });
  });
});

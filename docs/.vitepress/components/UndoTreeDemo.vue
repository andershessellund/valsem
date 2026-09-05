<script setup lang="ts">
import { computed, reactive } from 'vue';
import { intern, produce } from 'valsem';

interface Todo {
  text: string;
  done: boolean;
}
interface State {
  items: readonly Todo[];
  dark: boolean;
}

interface HNode {
  id: number;
  state: State;
  label: string;
  parent: HNode | null;
  children: HNode[];
}

const initial = intern<State>({
  items: [
    { text: 'write docs', done: false },
    { text: 'ship valsem', done: false },
  ],
  dark: false,
});

const root: HNode = { id: 0, state: initial, label: 'initial', parent: null, children: [] };

const g = reactive({
  nodes: [root] as HNode[],
  current: root as HNode,
  saved: initial as State,
  edits: 0,
  revisits: 0,
  noops: 0,
  flash: '' as string,
});

// States are canonical, so a plain identity Map is a structural index.
const byState = new Map<State, HNode>([[initial, root]]);

function apply(label: string, recipe: (d: { items: Todo[]; dark: boolean }) => void): void {
  g.edits++;
  const next = produce(g.current.state, recipe as (d: State) => void);
  if (next === g.current.state) {
    g.noops++;
    g.flash = `“${label}” netted out — produce returned the canonical base (===).`;
    return;
  }
  const existing = byState.get(next);
  if (existing) {
    g.revisits++;
    g.flash = `“${label}” reached state #${existing.id} again — same object, no new node.`;
    g.current = existing;
    return;
  }
  const node: HNode = {
    id: g.nodes.length,
    state: next,
    label,
    parent: g.current,
    children: [],
  };
  g.current.children.push(node);
  g.nodes.push(node);
  byState.set(next, node);
  g.current = node;
  g.flash = '';
}

let n = 0;
const presets = ['buy milk', 'water plants', 'fix bug #18', 'read TC39 notes'];
const addTodo = () =>
  apply('add todo', (d) => void d.items.push({ text: presets[n++ % presets.length]!, done: false }));
const toggle = (i: number) =>
  apply(`toggle #${i}`, (d) => {
    if (d.items[i]) d.items[i].done = !d.items[i].done;
  });
const removeDone = () => apply('clear done', (d) => void (d.items = d.items.filter((t) => !t.done)));
const toggleDark = () => apply('toggle theme', (d) => void (d.dark = !d.dark));
const undo = () => {
  if (g.current.parent) g.current = g.current.parent;
};
const redo = () => {
  const c = g.current.children;
  if (c.length > 0) g.current = c[c.length - 1]!;
};
const save = () => void (g.saved = g.current.state);
const jump = (node: HNode) => void (g.current = node);

const isDirty = computed(() => g.current.state !== g.saved); // THE dirty check
const sharePct = computed(() =>
  g.edits === 0 ? 0 : Math.round((100 * (g.edits - (g.nodes.length - 1))) / g.edits),
);

// Flatten the tree for rendering, depth-first with depth markers.
interface Row {
  node: HNode;
  depth: number;
}
const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  const walk = (node: HNode, depth: number) => {
    out.push({ node, depth });
    for (const c of node.children) walk(c, depth + 1);
  };
  walk(g.nodes[0]!, 0);
  return out;
});
</script>

<template>
  <div class="undo-demo">
    <div class="panes">
      <div class="pane">
        <h4>
          Document
          <span class="dirty" :class="{ on: isDirty }">{{
            isDirty ? 'unsaved changes' : 'saved'
          }}</span>
        </h4>
        <ul class="todos">
          <li v-for="(t, i) in g.current.state.items" :key="i">
            <label>
              <input type="checkbox" :checked="t.done" @change="toggle(i)" />
              <span :class="{ done: t.done }">{{ t.text }}</span>
            </label>
          </li>
        </ul>
        <div class="controls">
          <button @click="addTodo">add todo</button>
          <button @click="removeDone">clear done</button>
          <button @click="toggleDark">toggle theme ({{ g.current.state.dark ? 'dark' : 'light' }})</button>
        </div>
        <div class="controls">
          <button @click="undo" :disabled="!g.current.parent">↩ undo</button>
          <button @click="redo" :disabled="g.current.children.length === 0">↪ redo</button>
          <button @click="save" :disabled="!isDirty">save</button>
        </div>
        <p class="flash" :class="{ visible: g.flash !== '' }">{{ g.flash || ' ' }}</p>
      </div>

      <div class="pane">
        <h4>History tree <span class="hint">(click a node to time-travel)</span></h4>
        <ul class="tree">
          <li v-for="{ node, depth } in rows" :key="node.id">
            <button
              class="tnode"
              :class="{ current: node === g.current, saved: node.state === g.saved }"
              :style="{ marginLeft: depth * 18 + 'px' }"
              @click="jump(node)"
            >
              #{{ node.id }} {{ node.label }}
              <span v-if="node.state === g.saved" title="saved state">💾</span>
            </button>
          </li>
        </ul>
      </div>
    </div>

    <div class="stats">
      <div>
        <b>{{ g.edits }}</b> edits
      </div>
      <div>
        <b>{{ g.nodes.length }}</b> distinct states
      </div>
      <div>
        <b>{{ g.revisits }}</b> revisits (=== hits)
      </div>
      <div>
        <b>{{ g.noops }}</b> net no-ops
      </div>
      <div>
        <b>{{ sharePct }}%</b> of edits allocated no node
      </div>
    </div>
  </div>
</template>

<style scoped>
.undo-demo {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 16px;
  margin: 16px 0;
}
.panes {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
}
.pane {
  flex: 1 1 260px;
  min-width: 0;
}
.pane h4 {
  margin: 0 0 8px;
}
.hint {
  font-weight: normal;
  font-size: 0.8em;
  color: var(--vp-c-text-3);
}
.dirty {
  font-size: 0.75em;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--vp-c-green-soft);
  color: var(--vp-c-green-1);
  vertical-align: middle;
}
.dirty.on {
  background: var(--vp-c-yellow-soft);
  color: var(--vp-c-yellow-1);
}
.todos {
  list-style: none;
  padding: 0;
  margin: 0 0 8px;
}
.todos li {
  padding: 1px 0;
}
.todos .done {
  text-decoration: line-through;
  color: var(--vp-c-text-3);
}
.controls {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.controls button {
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 0.85em;
  background: var(--vp-c-bg-soft);
}
.controls button:hover:not(:disabled) {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
.controls button:disabled {
  opacity: 0.4;
}
.flash {
  min-height: 2.4em;
  margin: 6px 0 0;
  font-size: 0.8em;
  color: var(--vp-c-brand-1);
  opacity: 0;
  transition: opacity 0.15s;
}
.flash.visible {
  opacity: 1;
}
.tree {
  list-style: none;
  padding: 0;
  margin: 0;
  max-height: 300px;
  overflow: auto;
}
.tree li {
  padding: 1px 0;
}
.tnode {
  font-size: 0.82em;
  font-family: var(--vp-font-family-mono);
  border: 1px solid var(--vp-c-divider);
  border-radius: 5px;
  padding: 1px 8px;
  background: var(--vp-c-bg-soft);
}
.tnode:hover {
  border-color: var(--vp-c-brand-1);
}
.tnode.current {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  font-weight: 600;
}
.stats {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  border-top: 1px solid var(--vp-c-divider);
  margin-top: 14px;
  padding-top: 10px;
  font-size: 0.85em;
  color: var(--vp-c-text-2);
}
</style>

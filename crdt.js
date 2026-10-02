// Tiny sequence CRDT (RGA) shared by server and browser. Each character has a unique id "counter.client".
(function (root) {
  const ID = /^(\d{1,9})\.([a-z0-9]{1,8})$/;

  class Doc {
    constructor(cid) {
      this.cid = cid;
      this.clock = 0;
      this.head = { n: 0, c: '', ch: '', del: true, next: null };
      this.map = new Map([['', this.head]]);
    }
    static from(runs, cid) {
      const d = new Doc(cid);
      let tail = d.head;
      for (const [c, n0, s, del] of runs) {
        for (let i = 0; i < s.length; i++) {
          const node = { n: n0 + i, c, ch: s[i], del: !!del, next: null };
          tail.next = node; tail = node;
          d.map.set(node.n + '.' + c, node);
          if (node.n > d.clock) d.clock = node.n;
        }
      }
      return d;
    }
    static fromText(t) { return Doc.from(t ? [['s', 1, t, 0]] : [], 's'); }

    dump() {
      const runs = []; let last = null;
      for (let n = this.head.next; n; n = n.next) {
        if (last && last[0] === n.c && last[3] === (n.del ? 1 : 0) && last[1] + last[2].length === n.n) last[2] += n.ch;
        else runs.push(last = [n.c, n.n, n.ch, n.del ? 1 : 0]);
      }
      return runs;
    }
    text() {
      let s = '';
      for (let n = this.head.next; n; n = n.next) if (!n.del) s += n.ch;
      return s;
    }
    nodeAt(off) {            // node of the off-th visible char (head if off is 0)
      let prev = this.head, v = 0;
      for (let n = this.head.next; n && v < off; n = n.next) { prev = n; if (!n.del) v++; }
      return prev;
    }
    offsetOf(node) {         // visible chars up to and including node
      let v = 0;
      for (let n = this.head; ; n = n.next) {
        if (n !== this.head && !n.del) v++;
        if (n === node || !n.next) return v;
      }
    }
    add(n, c, ref, ch) {
      const k = n + '.' + c;
      if (this.map.has(k)) return true;
      let prev = this.map.get(ref);
      if (!prev) return false;
      let nx = prev.next;
      while (nx && (nx.n > n || (nx.n === n && nx.c > c))) { prev = nx; nx = nx.next; }
      const node = { n, c, ch, del: false, next: nx };
      prev.next = node;
      this.map.set(k, node);
      if (n > this.clock) this.clock = n;
      return true;
    }
    apply(op) {
      if (!op) return false;
      if (op.t === 'i') {
        const m = ID.exec(op.id);
        if (!m || typeof op.s !== 'string' || !op.s.length || op.s.length > 100000 || typeof op.ref !== 'string' || (op.ref !== '' && !ID.test(op.ref))) return false;
        const n0 = +m[1], c = m[2];
        let ref = op.ref;
        for (let i = 0; i < op.s.length; i++) {
          if (!this.add(n0 + i, c, ref, op.s[i])) return false;
          ref = (n0 + i) + '.' + c;
        }
        return true;
      }
      if (op.t === 'd' && Array.isArray(op.ids) && op.ids.length <= 100000) {
        for (const id of op.ids) { const nd = this.map.get(id); if (nd && nd !== this.head) nd.del = true; }
        return true;
      }
      return false;
    }
    // Local edit: at visible offset p, delete delN chars and insert ins. Applies and returns the ops to send.
    local(p, delN, ins) {
      const ops = [], prev = this.nodeAt(p);
      if (delN > 0) {
        const ids = [];
        for (let m = prev.next; m && ids.length < delN; m = m.next) if (!m.del) ids.push(m.n + '.' + m.c);
        if (ids.length) ops.push({ t: 'd', ids });
      }
      if (ins) ops.push({ t: 'i', id: (this.clock + 1) + '.' + this.cid, ref: prev === this.head ? '' : prev.n + '.' + prev.c, s: ins });
      ops.forEach((o) => this.apply(o));
      return ops;
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = Doc;
  else root.Doc = Doc;
})(typeof self !== 'undefined' ? self : this);

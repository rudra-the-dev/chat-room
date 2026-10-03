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
        if (!m || typeof op.s !== 'string' || !op.s.length || typeof op.ref !== 'string' || (op.ref !== '' && !ID.test(op.ref))) return false;
        const n0 = +m[1], c = m[2];
        let ref = op.ref;
        for (let i = 0; i < op.s.length; i++) {
          if (!this.add(n0 + i, c, ref, op.s[i])) return false;
          ref = (n0 + i) + '.' + c;
        }
        return true;
      }
      if (op.t === 'd' && Array.isArray(op.ids)) {
        for (const id of op.ids) { const nd = this.map.get(id); if (nd && nd !== this.head) nd.del = true; }
        return true;
      }
      return false;
    }
    // Local edit: at visible offset p, delete delN chars and insert ins. Applies and returns the ops to send.
    // Big edits are split into 50k-char chunks so no single message gets huge.
    local(p, delN, ins) {
      const CH = 50000, ops = [], prev = this.nodeAt(p);
      if (delN > 0) {
        let ids = [];
        for (let m = prev.next; m && delN > 0; m = m.next) {
          if (m.del) continue;
          ids.push(m.n + '.' + m.c); delN--;
          if (ids.length === CH) { ops.push({ t: 'd', ids }); ids = []; }
        }
        if (ids.length) ops.push({ t: 'd', ids });
      }
      let ref = prev === this.head ? '' : prev.n + '.' + prev.c;
      for (let i = 0; i < ins.length; i += CH) {
        const s = ins.slice(i, i + CH), n0 = this.clock + 1;
        const op = { t: 'i', id: n0 + '.' + this.cid, ref, s };
        this.apply(op);
        ops.push(op);
        ref = (n0 + s.length - 1) + '.' + this.cid;
      }
      ops.forEach((o) => o.t === 'd' && this.apply(o));
      return ops;
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = Doc;
  else root.Doc = Doc;
})(typeof self !== 'undefined' ? self : this);
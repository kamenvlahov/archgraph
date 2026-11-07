// Четец на SCIP индекс (protobuf). Чете само полетата, които archgraph ползва; останалите се прескачат.
// Номерата на полетата са от scip.proto (github.com/sourcegraph/scip).

export interface ScipDocument {
  path: string; // Document.relative_path = 1
  occurrences: ScipOccurrence[]; // Document.occurrences = 2
}

export interface ScipOccurrence {
  line: number; // от 1; Occurrence.range = 1 е [startLine, startChar, (endLine,) endChar] от 0
  symbol: string; // Occurrence.symbol = 2
  roles: number; // Occurrence.symbol_roles = 3
}

export const ROLE_DEFINITION = 0x1;

const decoder = new TextDecoder();

export function readScip(data: Uint8Array): ScipDocument[] {
  const documents: ScipDocument[] = [];
  read(data, (field, r) => {
    if (field === 2) documents.push(readDocument(r.bytes()));
    else r.skip();
  });
  return documents;
}

function readDocument(data: Uint8Array): ScipDocument {
  const doc: ScipDocument = { path: '', occurrences: [] };
  read(data, (field, r) => {
    if (field === 1) doc.path = decoder.decode(r.bytes());
    else if (field === 2) doc.occurrences.push(readOccurrence(r.bytes()));
    else r.skip();
  });
  return doc;
}

function readOccurrence(data: Uint8Array): ScipOccurrence {
  const occ: ScipOccurrence = { line: 0, symbol: '', roles: 0 };
  let range: number[] = [];
  read(data, (field, r) => {
    if (field === 1 && r.wire === 2) range = new Reader(r.bytes()).varints();
    else if (field === 1)
      range.push(r.varint()); // неупакован repeated
    else if (field === 2) occ.symbol = decoder.decode(r.bytes());
    else if (field === 3) occ.roles = r.varint();
    else r.skip();
  });
  occ.line = (range[0] ?? 0) + 1;
  return occ;
}

// Обхожда полетата на съобщение. `each` трябва да прочете или прескочи стойността.
function read(data: Uint8Array, each: (field: number, r: Reader) => void) {
  const r = new Reader(data);
  while (!r.done()) {
    const key = r.varint();
    r.wire = key & 7;
    each(Math.floor(key / 8), r);
  }
}

class Reader {
  wire = 0;
  private pos = 0;
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  done(): boolean {
    return this.pos >= this.data.length;
  }

  varint(): number {
    let result = 0;
    for (let shift = 0; ; shift += 7) {
      const b = this.data[this.pos++];
      if (b === undefined) throw new Error('счупен SCIP индекс');
      result += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return result;
    }
  }

  varints(): number[] {
    const out: number[] = [];
    while (!this.done()) out.push(this.varint());
    return out;
  }

  bytes(): Uint8Array {
    const len = this.varint();
    const out = this.data.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  skip() {
    if (this.wire === 0) this.varint();
    else if (this.wire === 2) this.bytes();
    else if (this.wire === 1) this.pos += 8;
    else if (this.wire === 5) this.pos += 4;
    else throw new Error(`непознат wire type ${this.wire} в SCIP индекс`);
  }
}

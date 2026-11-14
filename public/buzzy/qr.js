/* qr.js — QR Code encoder for BeeZilla. No dependencies; plain IIFE (static-server safe).
 *
 *   window.BeeZillaQR.encode(text, opts) -> { version, ecc, mask, size, matrix }
 *   window.BeeZillaQR.matrix(text, opts) -> boolean[][]  true = dark; the symbol only, no quiet zone
 *   window.BeeZillaQR.svg(text, opts)    -> string       square <svg> with a quiet zone
 *
 * Follows ISO/IEC 18004: byte mode over the UTF-8 bytes, versions 1-15, error correction
 * L, M, Q or H (default M). The smallest version that fits is used. Unless opts.mask forces
 * one, all eight masks are scored with the standard penalty rules and the lowest score wins
 * (a tie goes to the lower mask number). While scoring, the format, version and always-dark
 * modules are held light, because they are written only after the mask is chosen; this is
 * the convention of the segno encoder that the output was checked against.
 *
 * opts.ecc     "L" | "M" | "Q" | "H"        default "M"
 * opts.mask    0-7 forces that mask          default: lowest penalty
 * opts.margin  quiet zone in modules (svg)   default 4
 * opts.dark    dark colour (svg)             default "#141414"
 * opts.light   light colour (svg)            default "#FFFFFF"
 * opts.label   aria-label (svg)              default "QR code"
 * opts.size    width and height in px (svg)  default 256
 */
(function (root) {
  "use strict";

  var MAX_VERSION = 15;

  // Error-correction indicator bits in the format string: L=01, M=00, Q=11, H=10.
  var FORMAT_LEVEL_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  // ISO/IEC 18004 Table 9 for versions 1-15 (index 0 = version 1):
  // error-correction codewords per block, and the number of blocks.
  var EC_PER_BLOCK = {
    L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22],
    M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24],
    Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30],
    H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24]
  };
  var BLOCKS = {
    L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6],
    M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10],
    Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12],
    H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18]
  };

  // Alignment-pattern centre coordinates (Annex E), index = version - 1.
  var ALIGN = [
    [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62],
    [6, 26, 46, 66], [6, 26, 48, 70]
  ];

  // GF(256) with the field polynomial 0x11D, generator element 2.
  var GF_EXP = [];
  var GF_LOG = [];
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) GF_EXP[j] = GF_EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  // Generator polynomial (x - a^0)(x - a^1)...(x - a^(n-1)), highest power first, leading 1 included.
  function rsGenerator(n) {
    var g = [1];
    for (var i = 0; i < n; i++) {
      var next = [];
      for (var k = 0; k <= g.length; k++) next.push(0);
      for (var j = 0; j < g.length; j++) {
        next[j] ^= g[j];
        next[j + 1] ^= gfMul(g[j], GF_EXP[i]);
      }
      g = next;
    }
    return g;
  }

  // The n error-correction codewords: remainder of data(x) * x^n divided by the generator.
  function rsEncode(data, n) {
    var gen = rsGenerator(n);
    var rem = [];
    for (var i = 0; i < n; i++) rem.push(0);
    for (var d = 0; d < data.length; d++) {
      var factor = data[d] ^ rem[0];
      rem.shift();
      rem.push(0);
      for (var k = 0; k < n; k++) rem[k] ^= gfMul(gen[k + 1], factor);
    }
    return rem;
  }

  // Modules that carry codewords for a version (Annex E); floor(modules / 8) codewords.
  function rawModules(v) {
    var r = (16 * v + 128) * v + 64;
    if (v >= 2) {
      var a = Math.floor(v / 7) + 2;
      r -= (25 * a - 10) * a - 55;
      if (v >= 7) r -= 36;
    }
    return r;
  }

  function totalCodewords(v) {
    return Math.floor(rawModules(v) / 8);
  }

  function dataCodewords(v, ecc) {
    return totalCodewords(v) - EC_PER_BLOCK[ecc][v - 1] * BLOCKS[ecc][v - 1];
  }

  function countBits(v) {
    return v <= 9 ? 8 : 16;
  }

  function maxBytes(v, ecc) {
    return Math.floor((dataCodewords(v, ecc) * 8 - 4 - countBits(v)) / 8);
  }

  // UTF-8 bytes of a string. Lone surrogates become U+FFFD, as TextEncoder does.
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var cp = str.charCodeAt(i);
      if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
        var lo = str.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
          i++;
        } else {
          cp = 0xfffd;
        }
      } else if (cp >= 0xd800 && cp <= 0xdfff) {
        cp = 0xfffd;
      }
      if (cp < 0x80) {
        out.push(cp);
      } else if (cp < 0x800) {
        out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      } else if (cp < 0x10000) {
        out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      }
    }
    return out;
  }

  function chooseVersion(byteLength, ecc) {
    for (var v = 1; v <= MAX_VERSION; v++) {
      if (byteLength <= maxBytes(v, ecc)) return v;
    }
    throw new Error("The text is too long for a QR code at error level " + ecc +
      " (" + byteLength + " bytes; at most " + maxBytes(MAX_VERSION, ecc) + " fit).");
  }

  function appendBits(bits, value, count) {
    for (var i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  }

  // Interleaves the data blocks and their error-correction blocks (ISO/IEC 18004 8.6).
  function interleave(data, v, ecc) {
    var total = totalCodewords(v);
    var numBlocks = BLOCKS[ecc][v - 1];
    var ecLen = EC_PER_BLOCK[ecc][v - 1];
    var shortLen = Math.floor(total / numBlocks);     // codewords in a short block
    var numShort = numBlocks - (total % numBlocks);   // the short blocks come first
    var dataBlocks = [];
    var ecBlocks = [];
    var maxData = 0;
    var pos = 0;
    for (var b = 0; b < numBlocks; b++) {
      var len = shortLen - ecLen + (b < numShort ? 0 : 1);
      var block = data.slice(pos, pos + len);
      pos += len;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, ecLen));
      if (len > maxData) maxData = len;
    }
    var out = [];
    for (var i = 0; i < maxData; i++) {
      for (b = 0; b < numBlocks; b++) {
        if (i < dataBlocks[b].length) out.push(dataBlocks[b][i]);
      }
    }
    for (i = 0; i < ecLen; i++) {
      for (b = 0; b < numBlocks; b++) out.push(ecBlocks[b][i]);
    }
    return out;
  }

  // Byte-mode segment, terminator, byte alignment and pad codewords, then the RS blocks.
  function buildCodewords(bytes, v, ecc) {
    var capacity = dataCodewords(v, ecc) * 8;
    var bits = [];
    appendBits(bits, 0x4, 4);
    appendBits(bits, bytes.length, countBits(v));
    for (var i = 0; i < bytes.length; i++) appendBits(bits, bytes[i], 8);
    appendBits(bits, 0, Math.min(4, capacity - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);
    for (var pad = 0xec; bits.length < capacity; pad = pad === 0xec ? 0x11 : 0xec) {
      appendBits(bits, pad, 8);
    }
    var data = [];
    for (i = 0; i < bits.length; i += 8) {
      var byte = 0;
      for (var k = 0; k < 8; k++) byte = (byte << 1) | bits[i + k];
      data.push(byte);
    }
    return interleave(data, v, ecc);
  }

  // BCH(15,5) format string with the 0x5412 mask applied.
  function formatBits(ecc, mask) {
    var data = (FORMAT_LEVEL_BITS[ecc] << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  // BCH(18,6) version string, versions 7 and up.
  function versionBits(v) {
    var rem = v;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    return (v << 12) | rem;
  }

  // Where each of the 15 format bits sits, as [row, column, bit index]. Both copies.
  function formatCells(size) {
    var cells = [];
    var i;
    for (i = 0; i <= 5; i++) cells.push([i, 8, i]);
    cells.push([7, 8, 6], [8, 8, 7], [8, 7, 8]);
    for (i = 9; i <= 14; i++) cells.push([8, 14 - i, i]);
    for (i = 0; i <= 7; i++) cells.push([8, size - 1 - i, i]);
    for (i = 8; i <= 14; i++) cells.push([size - 15 + i, 8, i]);
    return cells;
  }

  function writeFormat(mod, size, ecc, mask) {
    var bits = formatBits(ecc, mask);
    var cells = formatCells(size);
    for (var k = 0; k < cells.length; k++) {
      mod[cells[k][0] * size + cells[k][1]] = (bits >>> cells[k][2]) & 1;
    }
  }

  // Function patterns, the reserved format and version areas, and the data codewords.
  // Returns { size, dark, fn }: dark holds the module values before masking, fn is 1 for
  // every module that is not a data module (those are the only ones a mask changes).
  function buildBase(v, codewords) {
    var size = v * 4 + 17;
    var dark = new Uint8Array(size * size);
    var fn = new Uint8Array(size * size);
    var reserved = [];   // format, version and always-dark modules: cleared while scoring masks

    function set(r, c, on) {
      dark[r * size + c] = on ? 1 : 0;
      fn[r * size + c] = 1;
    }

    // Finder patterns with their light separators, at three corners.
    var corners = [[0, 0], [0, size - 7], [size - 7, 0]];
    for (var f = 0; f < 3; f++) {
      for (var dy = -1; dy <= 7; dy++) {
        for (var dx = -1; dx <= 7; dx++) {
          var r = corners[f][0] + dy;
          var c = corners[f][1] + dx;
          if (r < 0 || c < 0 || r >= size || c >= size) continue;
          var inside = dy >= 0 && dy <= 6 && dx >= 0 && dx <= 6;
          var ring = inside && (dy === 0 || dy === 6 || dx === 0 || dx === 6);
          var core = inside && dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4;
          set(r, c, ring || core);
        }
      }
    }

    // Timing patterns along row 6 and column 6, between the finders.
    for (var i = 8; i < size - 8; i++) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }

    // Alignment patterns, except the three that would sit on a finder.
    var centres = ALIGN[v - 1];
    var last = centres.length - 1;
    for (var a = 0; a <= last; a++) {
      for (var b = 0; b <= last; b++) {
        if ((a === 0 && b === 0) || (a === 0 && b === last) || (a === last && b === 0)) continue;
        for (dy = -2; dy <= 2; dy++) {
          for (dx = -2; dx <= 2; dx++) {
            set(centres[a] + dy, centres[b] + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }

    // Format areas are reserved here and written per mask later; the always-dark module too.
    var cells = formatCells(size);
    for (var k = 0; k < cells.length; k++) {
      set(cells[k][0], cells[k][1], false);
      reserved.push(cells[k][0] * size + cells[k][1]);
    }
    set(size - 8, 8, true);
    reserved.push((size - 8) * size + 8);

    // Version information, versions 7 and up: the top-right block and its mirror.
    if (v >= 7) {
      var vb = versionBits(v);
      for (i = 0; i < 18; i++) {
        var on = ((vb >>> i) & 1) === 1;
        var p = size - 11 + (i % 3);
        var q = Math.floor(i / 3);
        set(q, p, on);
        set(p, q, on);
        reserved.push(q * size + p, p * size + q);
      }
    }

    // Data and error-correction bits, in the zigzag order of 8.7.3: pairs of columns from the
    // right edge, upward and downward alternately, skipping the timing column.
    var total = codewords.length * 8;
    var bit = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      var upward = ((right + 1) & 2) === 0;
      for (var vert = 0; vert < size; vert++) {
        var row = upward ? size - 1 - vert : vert;
        for (var j = 0; j < 2; j++) {
          var idx = row * size + right - j;
          if (!fn[idx] && bit < total) {
            dark[idx] = (codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1;
            bit++;
          }
        }
      }
    }
    return { size: size, dark: dark, fn: fn, reserved: reserved };
  }

  // Mask pattern m (8.8.1). True where the mask inverts a data module.
  function maskHit(m, r, c) {
    switch (m) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return (r * c) % 2 + (r * c) % 3 === 0;
      case 6: return ((r * c) % 2 + (r * c) % 3) % 2 === 0;
      default: return ((r + c) % 2 + (r * c) % 3) % 2 === 0;
    }
  }

  // The data modules with mask m applied. The reserved areas keep their base values here;
  // they are cleared while scoring and written only for the chosen mask.
  function maskedCopy(base, m) {
    var size = base.size;
    var mod = new Uint8Array(base.dark);
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (!base.fn[r * size + c] && maskHit(m, r, c)) mod[r * size + c] ^= 1;
      }
    }
    return mod;
  }

  // The finished symbol for mask m: masked data with the format information written.
  function finishSymbol(base, ecc, m) {
    var mod = maskedCopy(base, m);
    writeFormat(mod, base.size, ecc, m);
    return mod;
  }

  // True when modules [from, to) of a row or column are all light. Modules outside the
  // symbol count as light, as the quiet zone is light.
  function lightRun(line, n, from, to) {
    for (var i = from; i < to; i++) {
      if (i >= 0 && i < n && line[i] === 1) return false;
    }
    return true;
  }

  // Index of the first 1:1:3:1:1 pattern (dark light dark dark dark light dark) that starts at
  // or after `from`, or -1.
  function findFinder(line, n, from) {
    for (var k = Math.max(from, 0); k + 7 <= n; k++) {
      if (line[k] === 1 && line[k + 1] === 0 && line[k + 2] === 1 && line[k + 3] === 1 &&
          line[k + 4] === 1 && line[k + 5] === 0 && line[k + 6] === 1) return k;
    }
    return -1;
  }

  // Penalty for one row or column: N1 (runs of five or more) and N3 (a 1:1:3:1:1 pattern with
  // four light modules before or after it, 40 points each).
  function linePenalty(line, n) {
    var score = 0;
    var run = 1;
    for (var i = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) {
        run++;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    // After a counted pattern the scan resumes past it, so an overlapping match is not counted
    // again; after a bare match it resumes four modules on.
    var s = findFinder(line, n, 0);
    while (s !== -1) {
      if (lightRun(line, n, s - 4, s) || lightRun(line, n, s + 7, s + 11)) {
        score += 40;
        s = findFinder(line, n, s + 7);
      } else {
        s = findFinder(line, n, s + 4);
      }
    }
    return score;
  }

  // Total penalty of a masked symbol (8.8.2): N1, N2, N3 and N4.
  function penalty(mod, size) {
    var score = 0;
    var line = new Uint8Array(size);
    var i, j;
    for (i = 0; i < size; i++) {
      for (j = 0; j < size; j++) line[j] = mod[i * size + j];
      score += linePenalty(line, size);
    }
    for (i = 0; i < size; i++) {
      for (j = 0; j < size; j++) line[j] = mod[j * size + i];
      score += linePenalty(line, size);
    }
    // N2: each 2x2 block of one colour.
    for (var r = 0; r + 1 < size; r++) {
      for (var c = 0; c + 1 < size; c++) {
        var v = mod[r * size + c];
        if (v === mod[r * size + c + 1] && v === mod[(r + 1) * size + c] && v === mod[(r + 1) * size + c + 1]) {
          score += 3;
        }
      }
    }
    // N4: 10 points per whole 5% that the dark share strays from 50%.
    var dark = 0;
    var total = size * size;
    for (var k = 0; k < total; k++) dark += mod[k];
    score += 10 * Math.floor(Math.abs(dark * 20 - total * 10) / total);
    return score;
  }

  function encode(text, opts) {
    opts = opts || {};
    if (text === undefined || text === null) throw new Error("Nothing to encode.");
    var ecc = opts.ecc === undefined || opts.ecc === null ? "M" : String(opts.ecc).toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(FORMAT_LEVEL_BITS, ecc)) throw new Error("Error correction must be L, M, Q or H.");
    var forced = null;
    if (opts.mask !== undefined && opts.mask !== null) {
      forced = Number(opts.mask);
      if (!(Math.floor(forced) === forced && forced >= 0 && forced <= 7)) {
        throw new Error("Mask must be a whole number from 0 to 7.");
      }
    }
    var bytes = utf8Bytes(String(text));
    var v = chooseVersion(bytes.length, ecc);
    var base = buildBase(v, buildCodewords(bytes, v, ecc));
    var first = forced === null ? 0 : forced;
    var lastMask = forced === null ? 7 : forced;
    // Each candidate is scored with its reserved areas clear: the format, version and
    // always-dark modules are written only once the mask is chosen.
    var best = null;
    for (var m = first; m <= lastMask; m++) {
      var score = 0;
      if (forced === null) {
        var scored = maskedCopy(base, m);
        for (var k = 0; k < base.reserved.length; k++) scored[base.reserved[k]] = 0;
        score = penalty(scored, base.size);
      }
      if (best === null || score < best.score) best = { mask: m, score: score };
    }
    var mod = finishSymbol(base, ecc, best.mask);
    var size = base.size;
    var rows = [];
    for (var r = 0; r < size; r++) {
      var row = [];
      for (var c = 0; c < size; c++) row.push(mod[r * size + c] === 1);
      rows.push(row);
    }
    return { version: v, ecc: ecc, mask: best.mask, size: size, matrix: rows };
  }

  function matrix(text, opts) {
    return encode(text, opts).matrix;
  }

  function colour(value, fallback) {
    if (value === undefined || value === null) return fallback;
    var s = String(value);
    if (/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(s) || /^[a-zA-Z]{3,30}$/.test(s)) return s;
    throw new Error("A QR colour must be a hex colour such as #141414, or a plain colour name.");
  }

  function escapeAttr(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function svg(text, opts) {
    opts = opts || {};
    var result = encode(text, opts);
    var margin = opts.margin === undefined || opts.margin === null ? 4 : Number(opts.margin);
    if (!(Math.floor(margin) === margin && margin >= 0)) throw new Error("The quiet zone must be a whole number of modules.");
    var px = opts.size === undefined || opts.size === null ? 256 : Number(opts.size);
    if (!(px > 0)) throw new Error("The svg size must be a positive number of pixels.");
    var dark = colour(opts.dark, "#141414");
    var light = colour(opts.light, "#FFFFFF");
    var label = opts.label === undefined || opts.label === null ? "QR code" : String(opts.label);
    var n = result.size + 2 * margin;
    var d = [];
    for (var r = 0; r < result.size; r++) {
      for (var c = 0; c < result.size; c++) {
        if (result.matrix[r][c]) d.push("M" + (c + margin) + " " + (r + margin) + "h1v1h-1z");
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px +
      '" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges" role="img" aria-label="' +
      escapeAttr(label) + '">' +
      '<rect width="' + n + '" height="' + n + '" fill="' + light + '"/>' +
      '<path fill="' + dark + '" d="' + d.join("") + '"/></svg>';
  }

  root.BeeZillaQR = { encode: encode, matrix: matrix, svg: svg };
})(typeof window !== "undefined" ? window : this);

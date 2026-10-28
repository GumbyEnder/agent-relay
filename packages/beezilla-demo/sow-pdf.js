/* Minimal %PDF-1.4 from plain text. No deps. */
(function (root) {
  function enc(s) {
    return String(s)
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      .replace(/\r\n/g, "\n")
      .replace(/\n/g, "\\n");
  }

  function wrap(text, width) {
    const out = [];
    String(text).split("\n").forEach(function (line) {
      if (line.length <= width) {
        out.push(line);
        return;
      }
      var rest = line;
      while (rest.length > width) {
        out.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      out.push(rest);
    });
    return out;
  }

  root.beezillaSowPdf = function (text) {
    var lines = wrap(text, 90);
    var fontSize = 11;
    var lineHeight = 15;
    var pageTop = 750;
    var pageBottom = 50;
    var margin = 50;
    var per = Math.floor((pageTop - pageBottom) / lineHeight) || 40;
    var pages = [];
    for (var i = 0; i < lines.length; i += per) pages.push(lines.slice(i, i + per));
    if (!pages.length) pages = [[""]];

    var parts = [];
    var offset = 0;
    var offsets = [0];

    function emit(num, content) {
      offsets[num] = offset;
      var block = num + " 0 obj\n" + content + "\nendobj\n";
      parts.push(block);
      offset += block.length;
    }

    var header = "%PDF-1.4\n";
    parts.push(header);
    offset += header.length;

    var nPages = pages.length;
    var pageStart = 3;
    var streamStart = pageStart + nPages;
    var fontNum = streamStart + nPages;

    emit(1, "<< /Type /Catalog /Pages 2 0 R >>");
    var kids = pages
      .map(function (_, i) {
        return pageStart + i + " 0 R";
      })
      .join(" ");
    emit(2, "<< /Type /Pages /Kids [" + kids + "] /Count " + nPages + " >>");

    var streams = pages.map(function (pageLines) {
      var y = pageTop;
      var s = "";
      pageLines.forEach(function (line) {
        s += "BT /F1 " + fontSize + " Tf " + margin + " " + y + " Td (" + enc(line) + ") Tj ET\n";
        y -= lineHeight;
      });
      return s;
    });

    for (var p = 0; p < nPages; p++) {
      emit(
        pageStart + p,
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents " +
          (streamStart + p) +
          " 0 R /Resources << /Font << /F1 " +
          fontNum +
          " 0 R >> >> >>",
      );
    }
    for (var q = 0; q < nPages; q++) {
      var body = streams[q];
      emit(streamStart + q, "<< /Length " + body.length + " >>\nstream\n" + body + "endstream");
    }
    emit(fontNum, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

    var xrefOffset = offset;
    var size = fontNum + 1;
    var xref = "xref\n0 " + size + "\n0000000000 65535 f \n";
    for (var o = 1; o < size; o++) {
      xref += String(offsets[o] || 0).padStart(10, "0") + " 00000 n \n";
    }
    parts.push(xref);
    parts.push(
      "trailer\n<< /Size " + size + " /Root 1 0 R >>\nstartxref\n" + xrefOffset + "\n%%EOF",
    );
    return new TextEncoder().encode(parts.join(""));
  };
})(typeof window !== "undefined" ? window : globalThis);

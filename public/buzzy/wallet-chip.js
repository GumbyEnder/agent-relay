/* Honey Drops in the header, on every page that includes this file.
   The chip is decoration; the balance is authoritative only from /api/wallet.
   It sits BESIDE the nav, never inside it: the nav is one canonical list of
   links, and a chip inserted as its first child made the nav read wrong
   ("◈ 88 Drops, Talk, Library…" where every page should read the same). */
(function () {
  var nav = document.querySelector("header nav");
  if (!nav) return;
  var chip = document.createElement("a");
  chip.href = "/buzzy/wallet";
  chip.className = "hd-chip";
  chip.setAttribute("aria-label", "Your Honey Drops wallet");
  chip.textContent = "◈ …";
  if (nav.parentNode) nav.parentNode.insertBefore(chip, nav);
  else nav.insertBefore(chip, nav.firstChild);

  function paint(n) {
    chip.textContent = "◈ " + Number(n || 0).toLocaleString() + " Drops";
  }
  fetch("/api/wallet", { credentials: "same-origin" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (d && typeof d.balance === "number") paint(d.balance); })
    .catch(function () { chip.textContent = "◈ —"; });

  window.BZ_HONEY = { refresh: function () {
    return fetch("/api/wallet", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) paint(d.balance); return d; });
  }};
})();

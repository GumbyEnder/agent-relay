/**
 * Board slug/id resolution for agent poll/create.
 */
import { resolveProjectRef } from "../src/lib/project-ref";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

const projects = [
  { id: "board_pq3y44us4k2n", slug: "zeeva-mobile" },
  { id: "board_i80oou4gp0ri", slug: "devboard-app" },
];

assert(
  resolveProjectRef("zeeva-mobile", projects) === "board_pq3y44us4k2n",
  "slug → id",
);
assert(
  resolveProjectRef("board_pq3y44us4k2n", projects) === "board_pq3y44us4k2n",
  "id passthrough",
);
assert(resolveProjectRef("nope", projects) === null, "unknown → null");
assert(resolveProjectRef("all", projects) === null, "all sentinel");
assert(resolveProjectRef("  zeeva-mobile  ", projects) === "board_pq3y44us4k2n", "trim");
assert(resolveProjectRef("", projects) === null, "empty");

// Prefer id when both could match different rows (id wins)
assert(
  resolveProjectRef("board_i80oou4gp0ri", [
    { id: "board_other", slug: "board_i80oou4gp0ri" },
    { id: "board_i80oou4gp0ri", slug: "devboard-app" },
  ]) === "board_i80oou4gp0ri",
  "id match preferred over slug collision",
);

console.log("test-project-ref: ok");

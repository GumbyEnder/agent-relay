import {
  extractArtifactFromGitHubPayload,
  extractLinkedIssueNumbers,
  parseRelayReplyComment,
} from "../src/lib/github-ingest";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

function main() {
  assert(parseRelayReplyComment("/relay reply ship it") === "ship it", "slash reply");
  assert(parseRelayReplyComment("/relay reply\nmulti\nline")?.includes("multi"), "multiline");
  assert(parseRelayReplyComment("not a command") === null, "non-command");

  const nums = extractLinkedIssueNumbers("Fixes #12 and closes acme/app#3");
  assert(nums.includes(12) && nums.includes(3), "linked issues");

  const art = extractArtifactFromGitHubPayload({
    repository: { full_name: "acme/app" },
    pull_request: {
      html_url: "https://github.com/acme/app/pull/9",
      number: 9,
      title: "feat",
      body: "Fixes #12",
    },
  });
  assert(art?.url.includes("/pull/9"), "pr url");
  assert(art?.externalId === "github:acme/app#12", "external id");
  assert(art?.externalIds?.includes("github:acme/app#12"), "external ids");

  console.log("✓ github ingest extras (PR + slash reply)");
}

main();

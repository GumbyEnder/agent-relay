/**
 * The map of the brain: its three branches, the subjects knowledge is filed under, the
 * skills by what they are useful for, the kinds of asset, and the rules for a folder's
 * path. Plain tables and pure functions, no database and no model, so the tree is the same
 * everywhere and every rule can be tested (brain.ts builds the tree; agents.ts asks which
 * folders a new job belongs in).
 *
 * Owner, 2026-11-23: "At the core, it'll be like, instead of /C, it'll be like brain. And then
 * we'll have a division… /knowledge… /systems… /systems is where anything that isn't
 * knowledge lives. Think skills, think bots… we'll store the skills under what they're useful
 * for: web design, programming, etc. So you can find your programming skills easily…
 * Assets is everything that is like media that is going to be reused throughout, so we don't
 * recreate those assets." And: "using colors and shapes to help ground people's thinking and
 * where they are in the greater tree of knowledge."
 *
 * So each branch has a colour AND a shape, and keeps both everywhere it appears (the tree, the
 * breadcrumb, an agent's folder list): brain is a pink hexagon (a honeycomb cell), knowledge a
 * blue circle, systems a teal square, assets a violet triangle. None of the four is the green,
 * yellow or red of the privacy modes, so a folder never reads as a mode.
 */

export type BranchId = "knowledge" | "systems" | "assets";
export type Shape = "hexagon" | "circle" | "square" | "triangle";

export interface Branch {
  id: BranchId;
  label: string;
  shape: Shape;
  color: string;
  /** One sentence: what lives here, in the person's terms. */
  blurb: string;
}

/** The core of the tree. Every breadcrumb starts here, the way a computer's starts at C:. */
export const ROOT = {
  id: "brain" as const,
  label: "brain",
  shape: "hexagon" as Shape,
  color: "#F472B6",
  blurb: "Everything BeeZilla and your agents keep, in one tree: what they learned, how they work, and the files they made.",
};

export const BRANCHES: Branch[] = [
  {
    id: "knowledge",
    label: "knowledge",
    shape: "circle",
    color: "#4DA3FF",
    blurb: "What you and your agents have learned: decisions, facts and conversations, filed by subject.",
  },
  {
    id: "systems",
    label: "systems",
    shape: "square",
    color: "#2DD4BF",
    blurb: "How the work gets done: your bots (each with its agent.md and picture), the skills they use, and your recipes.",
  },
  {
    id: "assets",
    label: "assets",
    shape: "triangle",
    color: "#A78BFA",
    blurb: "Pictures, videos, music and files to use again, so nothing is made twice.",
  },
];

export const branchOf = (path: string): Branch | undefined => BRANCHES.find((b) => b.id === String(path).split("/")[0]);

// ── Subjects: where knowledge is filed ──────────────────────────────────────

export interface Subject {
  id: string;
  label: string;
  re: RegExp;
}

/**
 * The subjects, in the order they are tried: the first one that matches wins, so the
 * specific come before the general ("web design" before "programming", "real estate" before
 * "home", "closing costs" before "money"). BeeZilla's own work is mostly jobs around the
 * house, so a fact is filed by the job it belongs to first (brain.ts): a kitchen remodel's
 * budget is under home, not under money.
 */
export const SUBJECTS: Subject[] = [
  { id: "web-design", label: "Web design", re: /\b(?:web\s*design\w*|web\s*sites?|websites?|landing\s*pages?|home\s*pages?|homepages?|web\s*pages?|webpages?|css|html|tailwind|wordpress|squarespace|webflow|wix|ui\s*design|ux)\b/i },
  { id: "programming", label: "Programming", re: /\b(?:cod(?:e|es|ing|ed)|coders?|programm\w*|software|debug\w*|bugs?|apis?|javascript|typescript|python|golang|rust|ruby|php|kotlin|swift\s*ui|sql|databases?|github|git|repos?|repository|deploy\w*|servers?|backend|back-end|frontend|front-end|devops|compil\w*|npm|node\.?js|react|vue|nuxt|next\.js|algorithms?|regex|stack\s*trace|error\s+messages?)\b/i },
  { id: "real-estate", label: "Real estate", re: /\b(?:real\s*estate|propert(?:y|ies)|landlords?|tenants?|rentals?|leases?|mortgages?|listings?|realtors?|escrow|closing\s*costs?|open\s*house)\b/i },
  { id: "home", label: "Home", re: /\b(?:kitchens?|bathrooms?|remodel\w*|renovat\w*|repairs?|plumb\w*|roof\w*|contractors?|flooring|floors?|cabinets?|countertops?|drywall|hvac|furnace|decks?|fences?|garages?|basements?|attics?|siding|landscap\w*|gardens?|gardening|lawns?|yards?|houses?|home|apartments?|furniture|chores?|cleaning|laundry|handyman)\b/i },
  { id: "legal", label: "Legal", re: /\b(?:legal|law|lawyers?|attorneys?|contracts?|agreements?|privacy\s+polic\w*|nda|lawsuits?|court|compliance|licen[cs]es?|permits?|patents?|trademarks?|copyright)\b/i },
  { id: "money", label: "Money", re: /\b(?:budgets?|money|financ\w*|tax(?:es)?|invoic\w*|bills?|billing|expenses?|bank\w*|payments?|payroll|savings?|invest\w*|accounting|bookkeeping|prices?|pricing|costs?|quotes?|estimates?|loans?|debts?|credit|crypto\w*|stocks?|retire\w*)\b/i },
  { id: "health", label: "Health", re: /\b(?:health\w*|medical|doctors?|medic\w*|symptoms?|therap\w*|fitness|workouts?|exercis\w*|gym|diet\w*|nutrition|sleep\w*|meditat\w*|yoga|weight\s+loss|running|marathons?)\b/i },
  { id: "cooking", label: "Cooking", re: /\b(?:cook\w*|meals?|dinners?|lunch\w*|breakfasts?|bak(?:e|es|ing|er|ery)|foods?|menus?|groceries|grocery|snacks?)\b/i },
  { id: "travel", label: "Travel", re: /\b(?:travel\w*|trips?|vacations?|holidays?|flights?|hotels?|itinerar\w*|airbnb|passports?|visas?|cruises?|road\s*trips?)\b/i },
  { id: "events", label: "Events", re: /\b(?:events?|part(?:y|ies)|weddings?|birthdays?|anniversar\w*|celebrat\w*|conferences?|reunions?|baby\s+showers?|invitations?)\b/i },
  { id: "family", label: "Family", re: /\b(?:kids?|child(?:ren)?|parent\w*|family|families|bab(?:y|ies)|toddlers?|teen\w*|daycare|mom|dad)\b/i },
  { id: "pets", label: "Pets", re: /\b(?:pets?|dogs?|pupp(?:y|ies)|cats?|kittens?|vets?|veterinar\w*|aquariums?)\b/i },
  { id: "learning", label: "Learning", re: /\b(?:learn\w*|study\w*|studies|homework|school|class(?:es)?|courses?|lessons?|tutor\w*|exams?|education|spanish|french|german|japanese|chinese|italian)\b/i },
  { id: "music", label: "Music", re: /\b(?:music\w*|songs?|lullab(?:y|ies)|melod(?:y|ies)|beats?|playlists?|albums?|lyrics|guitar|piano|drums?|singing|bands?)\b/i },
  { id: "video", label: "Video", re: /\b(?:videos?|films?|movies?|youtube|clips?|footage|animations?|animated|trailers?|reels?|vlogs?)\b/i },
  { id: "marketing", label: "Marketing", re: /\b(?:marketing|ads?|advertis\w*|campaigns?|seo|social\s+media|instagram|facebook|tiktok|linkedin|twitter|newsletters?|promot\w*|followers)\b/i },
  { id: "art-and-design", label: "Art and design", re: /\b(?:design\w*|logos?|branding|illustrat\w*|draw\w*|sketch\w*|paint\w*|art|artwork|graphics?|posters?|flyers?|photos?|photograph\w*|pictures?|images?|icons?|fonts?|typography)\b/i },
  { id: "work", label: "Work", re: /\b(?:careers?|resum(?:e|es|é|és)|cv|interviews?|hiring|recruit\w*|salary|boss|co-?workers?|colleagues?|meetings?|office|workplace)\b/i },
  { id: "writing", label: "Writing", re: /\b(?:writ(?:e|es|ing|ten)|essays?|blogs?|articles?|stor(?:y|ies)|books?|novels?|poems?|poetry|copywriting|speech(?:es)?|letters?|e-?mails?|proofread\w*)\b/i },
  { id: "business", label: "Business", re: /\b(?:business\w*|compan(?:y|ies)|startups?|clients?|customers?|sales|crm|prospects?|shops?|stores?|etsy|shopify|inventory|suppliers?|vendors?|products?|investors?|revenue|profit\w*)\b/i },
  { id: "shopping", label: "Shopping", re: /\b(?:shopping|buy(?:ing)?|purchas\w*|gifts?|presents?|deals?|discounts?|coupons?)\b/i },
  { id: "research", label: "Research", re: /\b(?:research\w*|investigat\w*|compar(?:e|es|ing|ison)|find\s+out|look\s+into|fact-?check\w*)\b/i },
];

/** Where knowledge that fits no subject goes. */
export const GENERAL: Subject = { id: "general", label: "General", re: /$^/ };

export const subjectById = (id: string): Subject | undefined => (id === GENERAL.id ? GENERAL : SUBJECTS.find((s) => s.id === id));

/** The subject a text is about: the first one that matches, or "general". */
export function subjectOf(text: unknown): string {
  const t = typeof text === "string" ? text : "";
  if (!t.trim()) return GENERAL.id;
  for (const s of SUBJECTS) if (s.re.test(t)) return s.id;
  return GENERAL.id;
}

// ── Skills, filed by what they are useful for ───────────────────────────────

export interface Purpose {
  id: string;
  label: string;
}

/** The folders under systems/skills, A to Z by what a person would look for. */
export const PURPOSES: Purpose[] = [
  { id: "3d", label: "3D" },
  { id: "music", label: "Music" },
  { id: "numbers", label: "Numbers" },
  { id: "pictures", label: "Pictures" },
  { id: "programming", label: "Programming" },
  { id: "research", label: "Research" },
  { id: "teamwork", label: "Teamwork" },
  { id: "video", label: "Video" },
  { id: "web-design", label: "Web design" },
  { id: "writing", label: "Writing" },
];

export interface Skill {
  id: string;
  name: string;
  blurb: string;
  /** The purposes it is filed under. A skill belongs to no bot: any of them can use it. */
  uses: string[];
  /** The start of a request that uses it, put in the Talk box by "Try it". None: it is not asked for directly. */
  ask?: string;
}

/**
 * BeeZilla's own skills (the tools in toolRegistry.ts and the makers in server.ts), in
 * words a person reads. A skill is filed under every purpose it is useful for, so the
 * programming folder shows every skill that helps with programming; it is still one skill.
 */
export const SKILLS: Skill[] = [
  { id: "web_search", name: "Search the web", blurb: "Looks things up on the web and brings back what it found, and where.", uses: ["research", "programming", "web-design"], ask: "Search the web for " },
  { id: "read_web_page", name: "Read a web page", blurb: "Opens one web page and reads it: an article, a product page, a page of documentation.", uses: ["research", "programming", "web-design", "writing"], ask: "Read this page and tell me what matters: " },
  { id: "render_document", name: "Write a document", blurb: "Turns the work into a finished document to download: Word, PDF or a spreadsheet.", uses: ["writing"], ask: "Write it up as a document: " },
  { id: "calculate", name: "Calculator", blurb: "Exact sums, percentages and totals, worked out instead of guessed.", uses: ["numbers"], ask: "Work out " },
  { id: "generate_image", name: "Picture maker", blurb: "Draws a picture from a description, or changes one you have.", uses: ["pictures", "web-design"], ask: "Draw a picture of " },
  { id: "generate_music", name: "Music maker", blurb: "Makes a song or a piece of music from a description.", uses: ["music", "video"], ask: "Make a song about " },
  { id: "generate_video", name: "Video maker", blurb: "Makes a short video clip from a description or a picture.", uses: ["video"], ask: "Make a short video of " },
  { id: "model_3d", name: "3D maker", blurb: "Makes a 3D model you can turn around and download.", uses: ["3d"], ask: "Make a 3D model of " },
  { id: "ask_bzilla", name: "Ask BeeZilla", blurb: "One of your agents asks BeeZilla for something outside its job.", uses: ["teamwork"] },
  { id: "ask_agent", name: "Ask an agent", blurb: "BeeZilla asks one of your agents something that is its job.", uses: ["teamwork"] },
  { id: "make_agent", name: "Make an agent", blurb: "BeeZilla makes a new agent for one part of your life or work, with its own job and folders.", uses: ["teamwork"], ask: "Make me a new agent for " },
];

export const purposeById = (id: string): Purpose | undefined => PURPOSES.find((p) => p.id === id);

// ── Assets ──────────────────────────────────────────────────────────────────

export interface AssetKind {
  id: string;
  label: string;
}

/** The folders under assets. A file goes by what it is, then (when a folder grows) by the work it came from. */
export const ASSET_KINDS: AssetKind[] = [
  { id: "3d-models", label: "3D models" },
  { id: "files", label: "Other files" },
  { id: "music", label: "Music and sounds" },
  { id: "pictures", label: "Pictures" },
  { id: "videos", label: "Videos" },
];

/** Which asset folder a file belongs in, from its type and name. */
export function assetKindOf(contentType: unknown, filename: unknown): string {
  const ct = String(contentType ?? "").toLowerCase();
  const name = String(filename ?? "").toLowerCase();
  if (ct.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|svg|heic)$/.test(name)) return "pictures";
  if (ct.startsWith("video/") || /\.(mp4|mov|webm|m4v|avi|mkv)$/.test(name)) return "videos";
  if (ct.startsWith("audio/") || /\.(mp3|wav|m4a|ogg|flac|aac)$/.test(name)) return "music";
  if (ct.startsWith("model/") || /\.(glb|gltf|obj|stl|fbx|usdz)$/.test(name)) return "3d-models";
  return "files";
}

// ── Paths ───────────────────────────────────────────────────────────────────

/** How deep a folder may sit under brain/ (brain/knowledge/home/kitchen/2026 is four). */
export const MAX_DEPTH = 6;
const SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/** A folder name a person typed, as a path segment: "Kitchen Remodel!" → "kitchen-remodel". */
export function slug(text: unknown, fallback = "untitled"): string {
  const s = String(text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return s || fallback;
}

/**
 * A path under brain/, cleaned: "brain/Knowledge//Home/" → "knowledge/home". null when it is
 * not one: it must start with a branch, every part must be a plain name (letters, digits and
 * dashes), and it may not be deeper than MAX_DEPTH. The leading "brain/" is optional.
 */
export function cleanPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const parts = raw.trim().toLowerCase().replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (parts[0] === "brain") parts.shift();
  if (!parts.length || parts.length > MAX_DEPTH) return null;
  if (!BRANCHES.some((b) => b.id === parts[0])) return null;
  if (!parts.every((p) => SEGMENT.test(p))) return null;
  return parts.join("/");
}

/** Is `path` the folder `top` or somewhere inside it? */
export function within(path: string, top: string): boolean {
  return path === top || path.startsWith(top + "/");
}

/** A path segment in words, when nothing better is known: "web-design" → "Web design". */
export function words(segment: string): string {
  const s = String(segment ?? "").replace(/-/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** The fixed name of a folder the map itself defines, or null for a folder it doesn't. */
export function mapLabel(path: string): string | null {
  const p = path.split("/");
  if (p.length === 1) return BRANCHES.find((b) => b.id === p[0])?.label ?? null;
  if (p[0] === "knowledge" && p.length === 2) return subjectById(p[1]!)?.label ?? null;
  if (p[0] === "systems" && p.length === 2) return ({ bots: "Bots", skills: "Skills", recipes: "Recipes" } as Record<string, string>)[p[1]!] ?? null;
  if (p[0] === "systems" && p[1] === "skills" && p.length === 3) return purposeById(p[2]!)?.label ?? null;
  if (p[0] === "assets" && p.length === 2) return ASSET_KINDS.find((k) => k.id === p[1])?.label ?? null;
  return null;
}

// ── An agent's folders, from its job ───────────────────────────────────────

/** The most folders one agent lists as its own. */
export const DOMAINS_MAX = 12;

/**
 * The folders an agent with this job works in: the knowledge folder for the job's subject
 * and, when there are skills for it, the skills folder too. A job that fits no subject gets
 * a knowledge folder of its own, named after the job ("my Etsy shop" would be business; "bee
 * keeping" is knowledge/bee-keeping). [] when there is no job.
 */
export function domainsForJob(job: unknown): string[] {
  const text = typeof job === "string" ? job.trim() : "";
  if (!text) return [];
  const subject = subjectOf(text);
  if (subject === GENERAL.id) return [`knowledge/${slug(text.replace(/^(?:my|our|the)\s+/i, ""))}`];
  const out = [`knowledge/${subject}`];
  if (purposeById(subject)) out.push(`systems/skills/${subject}`);
  return out;
}

/** An agent's own list of folders, cleaned: real paths only, no repeats, at most DOMAINS_MAX. */
export function cleanDomains(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const r of raw) {
    const p = cleanPath(r);
    if (p && !out.includes(p)) out.push(p);
    if (out.length >= DOMAINS_MAX) break;
  }
  return out;
}

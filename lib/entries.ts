import type { Entry } from "@/lib/types";

export const PLACEHOLDERS = [
  "Begin writing",
  "Pick a thought and go",
  "Start typing",
  "What's on your mind",
  "Just start",
  "Type your first thought",
  "Start with one sentence",
  "Just say it",
];

export function randomPlaceholder(): string {
  return PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)];
}

export function createEntry(content = ""): Entry {
  const now = Date.now();
  return { id: crypto.randomUUID(), createdAt: now, updatedAt: now, content };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function entryFilename(entry: Entry): string {
  const d = new Date(entry.createdAt);
  const stamp = [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join("-");
  return `${entry.id}-${stamp}.md`;
}

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

export function entryDate(entry: Entry): string {
  return dateFormat.format(new Date(entry.createdAt));
}

export function entryPreview(entry: Entry): string {
  const line = entry.content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  return line.length > 30 ? `${line.slice(0, 30)}…` : line;
}

export function isToday(timestamp: number): boolean {
  const a = new Date(timestamp);
  const b = new Date();
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const WELCOME_PREFIX = "hi. welcome to freewrite";

export function isWelcomeEntry(content: string): boolean {
  return content.trimStart().toLowerCase().startsWith(WELCOME_PREFIX);
}

// The wording every device seeded before the guide was rewritten. Kept so a
// pristine old guide is still recognised as the guide — see isPristineWelcome.
const LEGACY_WELCOME_CONTENT = `hi. welcome to freewrite.

this is not a journaling app or a note-taking app. it's a tool purely to help you freewrite.

freewriting is a writing strategy developed in 1973: write continuously for a set time without worrying about grammar, spelling, or anything like that. a pure stream of consciousness.

using it is super simple:

1. think of a topic to write about (a breakup, a struggle at work, a new idea)
2. click fullscreen
3. click the timer
4. start writing. no backspaces allowed. don't stop writing.

once the timer is done, the bar will fade back in — and you'll know to stop.

some basic rules:

- again, no backspaces (there's a toggle at the bottom to enforce it)
- no fixing spelling
- little 5-10s breaks are fine, but try to not stop typing
- no need to stay on topic — let your mind wander
- no judgment. trust your mind.

if 15 minutes sounds scary, scroll on the timer to shorten it. start with 5.

a starting prompt that works: "what am i working on today? why is that the most important thing for me to work on?" — don't stop writing for 15 minutes. do it 3 days straight.

little bonus features:

1. once you finish a session, click "chat". it'll push your entry to chatgpt or claude to help you reflect, with a custom prompt baked in. ai is really good at making connections you might not see.

2. the font and size should reflect the mood of your writing. larger lato for emotional entries, 18px serif for business ideas. the random button helps you find the vibe.

3. click the clock on the bottom right to see your history. everything is saved locally in this browser — nothing ever leaves your machine. hover an entry to download it as markdown.

4. there's also a reader. click "read", paste a link to any article, and read it without the noise. saved locally too.

5. there is no spellcheck. there is no markdown. this is on purpose. it doesn't matter.

freewrite is an open-source mac app by farza (github.com/farzaa/freewrite). this is the web version.

now, new entry. timer. go.
`;

export const WELCOME_CONTENT = `hi. welcome to freewrite.

freewriting is a writing strategy from 1973: write continuously for a set time without worrying about grammar, spelling, or anything like that. a pure stream of consciousness.

a timer, no backspaces, and nothing else on the screen. that's the part worth protecting, and it's what the rest of this is built around.

1. think of a topic (a breakup, a struggle at work, a new idea)
2. click fullscreen
3. click the timer
4. start writing. don't stop.

once the timer is done, the bar will fade back in — and you'll know to stop.

the rules: no backspaces (there's a toggle at the bottom that enforces it), no fixing spelling, no staying on topic. little 5-10s breaks are fine, but try not to stop typing. no judgment. trust your mind.

if 15 minutes sounds scary, scroll on the timer to shorten it. start with 5.

a prompt that works: "what am i working on today? why is that the most important thing for me to work on?" — 15 minutes, 3 days straight.

then the timer stops, and what you wrote is still here. that half matters too:

- the clock, bottom right, is everything you've written. it lives in this browser, and signing in brings it with you to any device you write on.
- "chat" hands an entry to chatgpt or claude with a prompt baked in. ai is good at connections you won't see.
- "share" turns an entry into a link. "preview" renders it as markdown, for when a session turns into something you're actually building.
- "read" is for everything you didn't write: paste a link, read it without the noise, or have it read out loud to you.
- type "/" mid-sentence. that's where the stranger features live, and where new ones show up.

the font should match the mood — larger lato when it's emotional, 18px serif when it's an idea. "random" finds it faster than you will.

there's no spellcheck. that one's on purpose.

freewrite is an open-source mac app by farza (github.com/farzaa/freewrite). this is the web version.

now, new entry. timer. go.
`;

// A guide nobody has touched yet, in either wording. Sync leans on this to
// leave the seeded guide alone; the moment it's edited it stops matching and
// becomes writing like anything else.
const PRISTINE_WELCOMES = new Set([WELCOME_CONTENT, LEGACY_WELCOME_CONTENT]);

export function isPristineWelcome(content: string): boolean {
  return PRISTINE_WELCOMES.has(content);
}

export const MIN_CHAT_LENGTH = 350;
export const MAX_URL_LENGTH = 6000;

const GPT_BASE = "https://chat.openai.com/?prompt=";
const CLAUDE_BASE = "https://claude.ai/new?q=";

export const GPT_PROMPT = `below is my journal entry. wyt? talk through it with me like a friend. don't therpaize me and give me a whole breakdown, don't repeat my thoughts with headings. really take all of this, and tell me back stuff truly as if you're an old homie.

Keep it casual, dont say yo, help me make new connections i don't see, comfort, validate, challenge, all of it. dont be afraid to say a lot. format with markdown headings if needed.

do not just go through every single thing i say, and say it back to me. you need to proccess everythikng is say, make connections i don't see it, and deliver it all back to me as a story that makes me feel what you think i wanna feel. thats what the best therapists do.

ideally, you're style/tone should sound like the user themselves. it's as if the user is hearing their own tone but it should still feel different, because you have different things to say and don't just repeat back they say.

else, start by saying, "hey, thanks for showing me this. my thoughts:"

my entry:`;

export const CLAUDE_PROMPT = `Take a look at my journal entry below. I'd like you to analyze it and respond with deep insight that feels personal, not clinical.
Imagine you're not just a friend, but a mentor who truly gets both my tech background and my psychological patterns. I want you to uncover the deeper meaning and emotional undercurrents behind my scattered thoughts.
Keep it casual, dont say yo, help me make new connections i don't see, comfort, validate, challenge, all of it. dont be afraid to say a lot. format with markdown headings if needed.
Use vivid metaphors and powerful imagery to help me see what I'm really building. Organize your thoughts with meaningful headings that create a narrative journey through my ideas.
Don't just validate my thoughts - reframe them in a way that shows me what I'm really seeking beneath the surface. Go beyond the product concepts to the emotional core of what I'm trying to solve.
Be willing to be profound and philosophical without sounding like you're giving therapy. I want someone who can see the patterns I can't see myself and articulate them in a way that feels like an epiphany.
Start with 'hey, thanks for showing me this. my thoughts:' and then use markdown headings to structure your response.

Here's my journal entry:`;

export type ChatProvider = "chatgpt" | "claude";

export function fullPrompt(provider: ChatProvider, entryText: string): string {
  const prompt = provider === "chatgpt" ? GPT_PROMPT : CLAUDE_PROMPT;
  return `${prompt}\n\n${entryText}`;
}

export function chatUrl(provider: ChatProvider, entryText: string): string {
  const base = provider === "chatgpt" ? GPT_BASE : CLAUDE_BASE;
  return base + encodeURIComponent(fullPrompt(provider, entryText));
}

export function isUrlTooLong(entryText: string): boolean {
  return (
    chatUrl("chatgpt", entryText).length > MAX_URL_LENGTH ||
    chatUrl("claude", entryText).length > MAX_URL_LENGTH
  );
}

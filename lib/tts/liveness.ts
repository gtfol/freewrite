// Did the last listening session end, or was it ended?
//
// A page that runs a speech engine on a phone can be taken away rather than
// left: iOS reclaims the content process under memory pressure and the browser
// restores the tab, which arrives as an ordinary page load. From inside, the
// two are hard to tell apart, and on a phone there is no console to ask.
//
// There is exactly one place they differ. `pagehide` fires when a page is
// navigated away from, reloaded or closed, and does not fire when the process
// is killed underneath it. So a session that was listening and left no mark on
// its way out did not go on its own — and the reader gets told that, instead
// of watching the article silently start over.

const KEY = "freewrite:listening";

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    // Storage denied. The reader loses an explanation, nothing else.
    return null;
  }
}

// The article that was playing when the page last disappeared without warning,
// or null if the last exit was an ordinary one. Read before markListening
// overwrites it — during render rather than in an effect.
export function interruptedArticle(): string | null {
  return read();
}

// Leaves a mark for as long as this article is being listened to, and clears
// it on the way out however that happens: unmounting, or the page going away.
export function markListening(articleId: string): () => void {
  try {
    localStorage.setItem(KEY, articleId);
  } catch {
    return () => {};
  }

  const clear = () => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // Nothing to do; the mark is a hint, not a record.
    }
  };

  // pagehide rather than beforeunload: iOS fires the latter unreliably, and
  // this one also covers the tab being closed outright.
  window.addEventListener("pagehide", clear);
  return () => {
    window.removeEventListener("pagehide", clear);
    clear();
  };
}

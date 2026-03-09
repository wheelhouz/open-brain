const TLDS = new Set([
  "com", "org", "net", "io", "ai", "dev", "co", "me", "app", "xyz",
  "info", "biz", "us", "uk", "ca", "de", "fr", "au", "edu", "gov",
  "mil", "int", "tv", "cc", "gg", "sh", "ly", "to", "fm", "so",
  "ac", "be", "ch", "cz", "dk", "es", "fi", "hr", "hu", "id", "ie",
  "il", "in", "is", "it", "jp", "kr", "lt", "lv", "mx", "nl", "no",
  "nz", "pl", "pt", "ro", "rs", "ru", "se", "sg", "sk", "th", "tr",
  "tw", "ua", "za",
]);

const ABBREVS = new Set(["e.g", "i.e", "etc", "vs", "vol", "dept", "govt"]);

const URL_RE =
  /https?:\/\/[^\s)\]>,;!"']+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,})(?:\/[^\s)\]>,;!"']*)?/gi;

/** Protect code blocks, inline code, and markdown links from transformation */
const PROTECTED_RE = /```[\s\S]*?```|`[^`]+`|\[[^\]]*\]\([^)]*\)/g;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function makeLink(url: string, label: string): string {
  return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
}

export function autoLink(text: string): string {
  // Replace protected regions with placeholders
  const placeholders: string[] = [];
  let working = text.replace(PROTECTED_RE, (match) => {
    placeholders.push(match);
    return `\0P${placeholders.length - 1}\0`;
  });

  // Replace URLs
  working = working.replace(URL_RE, (match) => {
    // Strip trailing punctuation that's likely sentence-ending
    let trailing = "";
    const trailMatch = match.match(/[.)]+$/);
    if (trailMatch) {
      // Count open/close parens in match to handle balanced parens
      const openCount = (match.match(/\(/g) || []).length;
      const closeCount = (match.match(/\)/g) || []).length;
      if (closeCount > openCount) {
        // Strip trailing periods and excess closing parens
        let url = match;
        trailing = "";
        while (url.length > 0) {
          const last = url[url.length - 1];
          if (last === "." && !url.endsWith("..")) {
            trailing = last + trailing;
            url = url.slice(0, -1);
          } else if (last === ")" && closeCount > openCount) {
            trailing = last + trailing;
            url = url.slice(0, -1);
            break; // only strip one unbalanced paren
          } else {
            break;
          }
        }
        match = url;
      } else if (trailMatch[0] === ".") {
        trailing = ".";
        match = match.slice(0, -1);
      }
    }

    const isExplicit = match.match(/^https?:\/\//i);

    // For bare domains, check TLD and abbreviations
    if (!isExplicit) {
      // Extract the TLD from the match
      const bareMatch = match.match(
        /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,})/i
      );
      if (!bareMatch) return match + trailing;
      const matchedTld = bareMatch[1].toLowerCase();

      if (!TLDS.has(matchedTld)) return match + trailing;

      // Check if this looks like an abbreviation (e.g., i.e., etc.)
      const domainWithoutTld = match.split("/")[0];
      const domainParts = domainWithoutTld.split(".");
      // Check each prefix segment as potential abbreviation
      for (let i = 0; i < domainParts.length - 1; i++) {
        const abbr = domainParts.slice(0, i + 1).join(".");
        if (ABBREVS.has(abbr.toLowerCase())) return match + trailing;
      }
    }

    const href = isExplicit ? match : `https://${match}`;

    // GitHub special handling
    const ghMatch = href.match(
      /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/(issues|pull|commit)\/([^/?#]+))?(?:[/?#].*)?$/
    );
    if (ghMatch) {
      const [, owner, repo, type, num] = ghMatch;
      let label: string;
      if (type === "issues" && num) label = `${owner}/${repo}#${num}`;
      else if (type === "pull" && num) label = `${owner}/${repo}!${num}`;
      else if (type === "commit" && num) label = `${owner}/${repo}@${num.slice(0, 7)}`;
      else if (!type) label = `${owner}/${repo}`;
      else label = match; // fallback for other GitHub paths

      const svg = `<svg class="auto-link-gh-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
      return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" class="auto-link-gh">${svg}<span>${esc(label)}</span></a>${trailing}`;
    }

    return makeLink(href, match) + trailing;
  });

  // Restore protected regions
  working = working.replace(/\0P(\d+)\0/g, (_, idx) => placeholders[Number(idx)]);

  return working;
}

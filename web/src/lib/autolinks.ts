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
  /https?:\/\/[^\s)\]>,;!?"']+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,})(?:\/[^\s)\]>,;!?"']*)?/gi;

/** Protect code blocks, inline code, and markdown links from transformation */
const PROTECTED_RE = /```[\s\S]*?```|`[^`]+`|\[[^\]]*\]\([^)]*\)/g;

function makeLink(url: string, label: string): string {
  return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

export function autoLink(text: string): string {
  // Replace protected regions with placeholders
  const placeholders: string[] = [];
  let working = text.replace(PROTECTED_RE, (match) => {
    placeholders.push(match);
    return `\0P${placeholders.length - 1}\0`;
  });

  // Replace URLs
  working = working.replace(URL_RE, (match, tld, offset) => {
    // Strip trailing punctuation that's likely sentence-ending
    let trailing = "";
    const trailMatch = match.match(/[.)]+$/);
    if (trailMatch) {
      const trail = trailMatch[0];
      // For balanced parens, only strip if unbalanced
      let stripped = trail;
      // Count open/close parens in match to handle balanced parens
      const openCount = (match.match(/\(/g) || []).length;
      const closeCount = (match.match(/\)/g) || []).length;
      if (closeCount > openCount) {
        // Strip excess closing parens
        const excess = closeCount - openCount;
        const trailParens = (trail.match(/\)/g) || []).length;
        const parensToStrip = Math.min(excess, trailParens);
        // Rebuild: strip trailing periods and excess parens
        stripped = trail;
        // Simple approach: strip one trailing char at a time if it's ) or .
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
      } else if (trail === ".") {
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

      // Check for abbreviations: look at the text before the match
      const before = working.slice(0, offset);
      // Check if this looks like an abbreviation (e.g., i.e., etc.)
      // The abbrev pattern: the part before the TLD dot
      const domainWithoutTld = match.split("/")[0];
      const domainParts = domainWithoutTld.split(".");
      // Check each prefix segment as potential abbreviation
      for (let i = 0; i < domainParts.length - 1; i++) {
        const abbr = domainParts.slice(0, i + 1).join(".");
        if (ABBREVS.has(abbr.toLowerCase())) return match + trailing;
      }
    }

    const href = isExplicit ? match : `https://${match}`;
    return makeLink(href, match) + trailing;
  });

  // Restore protected regions
  working = working.replace(/\0P(\d+)\0/g, (_, idx) => placeholders[Number(idx)]);

  return working;
}

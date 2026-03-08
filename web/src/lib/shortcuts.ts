import { route } from "preact-router";
import { selectedThoughtId } from "../state";

const TABS = ["/", "/topics", "/people", "/stats", "/chat"];

function isEditing(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
}

export function initShortcuts() {
  window.addEventListener("keydown", (e) => {
    // Don't intercept when typing in inputs (except specific shortcuts)
    if (isEditing()) {
      // Escape blurs from input
      if (e.key === "Escape") {
        (document.activeElement as HTMLElement)?.blur();
        e.preventDefault();
      }
      return;
    }

    switch (e.key) {
      case "/":
        e.preventDefault();
        document.getElementById("search-input")?.focus();
        break;

      case "Escape":
        if (selectedThoughtId.value) {
          selectedThoughtId.value = null;
          e.preventDefault();
        }
        break;

      case "n":
        e.preventDefault();
        document.getElementById("capture-input")?.focus();
        break;

      case "j":
      case "k":
        navigateCards(e.key === "j" ? 1 : -1);
        e.preventDefault();
        break;

      case "Enter":
        if (selectedThoughtId.value === null) {
          // Select the focused card
          const focused = document.querySelector("[data-thought-id]:focus");
          if (focused) {
            const id = focused.getAttribute("data-thought-id");
            if (id) selectedThoughtId.value = id;
          }
        }
        break;

      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
        route(TABS[parseInt(e.key) - 1]);
        e.preventDefault();
        break;
    }
  });
}

function navigateCards(direction: 1 | -1) {
  const cards = Array.from(
    document.querySelectorAll("[data-thought-id]"),
  ) as HTMLElement[];
  if (cards.length === 0) return;

  const currentIdx = cards.findIndex(
    (c) => c.getAttribute("data-thought-id") === selectedThoughtId.value,
  );

  let nextIdx: number;
  if (currentIdx === -1) {
    nextIdx = direction === 1 ? 0 : cards.length - 1;
  } else {
    nextIdx = currentIdx + direction;
    if (nextIdx < 0) nextIdx = 0;
    if (nextIdx >= cards.length) nextIdx = cards.length - 1;
  }

  const card = cards[nextIdx];
  const id = card.getAttribute("data-thought-id");
  if (id) {
    selectedThoughtId.value = id;
    card.scrollIntoView({ block: "nearest" });
    card.focus();
  }
}

# Loop Chips in Chat — Design

**Date:** 2026-03-20

## Problem

The broker returns loops alongside thoughts in chat, but the UI only renders thought source chips. Loop results are in the SSE payload but invisible to the user.

## Design

Add a separate labeled "loops" chip section below the existing thought source chips in `ChatView.tsx`. Each loop chip shows truncated content and loop type. Clicking opens the existing `LoopDetailPanel` via the `selectedLoopId` signal.

### Changes

**`web/src/api.ts`** — Add `SourceLoop` interface:
```typescript
interface SourceLoop {
  id: string;
  content: string;
  score: number;
  loop_type: string;
}
```

**`web/src/views/ChatView.tsx`:**
- Parse `loops` from SSE sources event (already sent by backend)
- Store in `ChatEntry.loops`
- New `LoopChips` component below `SourceChips` — label with count + icon, horizontal scroll of chips
- Each chip: truncated content + loop type badge
- onClick: `selectedLoopId.value = loop.id`
- Hidden when no loops returned

**`web/src/styles/globals.css`:**
- `.chat-loop-chip` styles paralleling `.chat-source-chip`
- Loop type label styled as accent badge instead of similarity percentage

### No changes needed
- `LoopDetailPanel` — already works via `selectedLoopId` signal
- Backend — already sends loops in SSE payload
- `state.ts` — `selectedLoopId` signal already exists

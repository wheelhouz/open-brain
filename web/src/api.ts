const STORAGE_KEY = "brain_access_key";

function getKey(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export function setKey(key: string) {
  localStorage.setItem(STORAGE_KEY, key);
}

export function clearKey() {
  localStorage.removeItem(STORAGE_KEY);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const key = getKey();
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string>) || {}),
  };
  if (key) headers["Authorization"] = `Bearer ${key}`;

  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) throw new Error("Unauthorized");
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// Types
export interface Thought {
  id: string;
  content: string;
  metadata: {
    type?: string;
    topics?: string[];
    people?: string[];
    action_items?: Array<string | { content: string; loop_type: string }>;
    dates_mentioned?: string[];
    source_context?: string;
    content_hash?: string;
  };
  created_at: string;
  updated_at: string;
  similarity?: number;
  parent_id?: string | null;
  thread_count?: number;
  loop_count?: number;
}

export interface ThoughtsResponse {
  thoughts: Thought[];
  next_cursor: string | null;
}

export interface SearchResponse {
  results: (Thought & { similarity: number })[];
}

export interface StatsResponse {
  total: number;
  types: { type: string; count: number }[];
  topics: { topic: string; count: number }[];
  people: { person: string; count: number }[];
  sources: { source: string; count: number }[];
  daily: { date: string; count: number }[];
}

export interface TopicEntry {
  topic: string;
  count: number;
  last_seen: string;
  category: string;
}

export interface PersonEntry {
  person: string;
  count: number;
  last_seen: string;
}

export interface Entity {
  id: string;
  canonical_name: string;
  entity_type: string;
  aliases: string[];
  attributes: Record<string, unknown>;
  mention_count: number;
  last_seen: string | null;
  created_at: string;
}

export interface MergeCluster {
  canonical: string;
  merge: string[];
  reason: string;
}

export interface Loop {
  id: string;
  content: string;
  loop_type: "task" | "question" | "decision" | "waiting_on";
  status: "open" | "closed" | "snoozed";
  resolution: string | null;
  source_thought_id: string | null;
  snoozed_until: string | null;
  created_at: string;
  closed_at: string | null;
  evidence_count: number;
  last_evidence_at: string | null;
  source_preview: string | null;
}

export interface LoopsResponse {
  loops: Loop[];
  next_cursor: string | null;
}

export interface CaptureResponse {
  id: string;
  metadata: Thought["metadata"];
  created_at: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SourceThought {
  id: string;
  content: string;
  similarity: number;
}

// API methods
export const api = {
  validate: () => request<StatsResponse>("/api/stats"),

  thoughts: (params?: {
    type?: string;
    topic?: string;
    person?: string;
    days?: string;
    source?: string;
    cursor?: string;
    limit?: number;
  }) => {
    const search = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") search.set(k, String(v));
      }
    }
    const qs = search.toString();
    return request<ThoughtsResponse>(`/api/thoughts${qs ? `?${qs}` : ""}`);
  },

  thought: (id: string) => request<Thought>(`/api/thoughts/${id}`),

  related: (id: string) =>
    request<{ related: (Thought & { similarity: number })[] }>(
      `/api/thoughts/${id}/related`,
    ),

  updateTopics: (id: string, add?: string[], remove?: string[]) =>
    request<{ id: string; topics: string[] }>(`/api/thoughts/${id}/topics`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ add, remove }),
    }),

  updateThought: (id: string, content: string, reprocess?: boolean) =>
    request<Thought>(`/api/thoughts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, reprocess: reprocess || false }),
    }),

  deleteThought: (id: string) =>
    request<{ deleted: boolean; id: string }>(`/api/thoughts/${id}`, {
      method: "DELETE",
    }),

  search: (query: string, threshold?: number, limit?: number) =>
    request<SearchResponse>("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, threshold, limit }),
    }),

  capture: (content: string, source?: string, parent_id?: string) =>
    request<CaptureResponse>("/api/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, source: source || "web", parent_id }),
    }),

  thread: (id: string) =>
    request<{ thread: Thought[] }>(`/api/thoughts/${id}/thread`),

  stats: () => request<StatsResponse>("/api/stats"),

  topics: () => request<{ topics: TopicEntry[]; categories: string[] }>("/api/topics"),

  categorizeTopics: () =>
    request<{ categories: string[]; assigned: number; swept: number }>("/api/topics/categorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),

  people: () => request<{ people: PersonEntry[] }>("/api/people"),

  renameTopic: (oldName: string, newName: string) =>
    request<{ renamed: boolean; from: string; to: string; affected: number }>(
      `/api/topics/${encodeURIComponent(oldName)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      },
    ),

  analyzeTopics: () =>
    request<{ clusters: MergeCluster[] }>("/api/topics/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),

  mergeTopics: (merges: Array<{ canonical: string; merge: string[] }>) =>
    request<{ applied: number; thoughts_updated: number }>("/api/topics/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ merges }),
    }),

  loops: (status?: string, loopType?: string) => {
    const search = new URLSearchParams();
    if (status) search.set("status", status);
    if (loopType) search.set("loop_type", loopType);
    const qs = search.toString();
    return request<LoopsResponse>(`/api/loops${qs ? `?${qs}` : ""}`);
  },

  loop: (id: string) => request<Loop & { evidence: Thought[] }>(`/api/loops/${id}`),

  loopsByThought: (thoughtId: string) =>
    request<LoopsResponse>(`/api/loops?source_thought_id=${encodeURIComponent(thoughtId)}`),

  closeLoop: (id: string, resolution?: string) =>
    request<{ updated: boolean }>(`/api/loops/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed", resolution }),
    }),

  snoozeLoop: (id: string, until: string) =>
    request<{ updated: boolean }>(`/api/loops/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "snoozed", snoozed_until: until }),
    }),

  reopenLoop: (id: string) =>
    request<{ updated: boolean }>(`/api/loops/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "open" }),
    }),

  createLoop: (content: string, loopType?: string) =>
    request<{ id: string; created_at: string }>("/api/loops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, loop_type: loopType || "task" }),
    }),

  deleteLoop: (id: string) =>
    request<{ deleted: boolean }>(`/api/loops/${id}`, {
      method: "DELETE",
    }),

  entities: (type?: string) => {
    const search = new URLSearchParams();
    if (type) search.set("type", type);
    const qs = search.toString();
    return request<{ entities: Entity[] }>(`/api/entities${qs ? `?${qs}` : ""}`);
  },

  entity: (id: string) => request<Entity>(`/api/entities/${id}`),

  updateEntity: async (id: string, data: { canonical_name?: string; aliases?: string[]; attributes?: unknown }) => {
    const key = getKey();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (key) headers["Authorization"] = `Bearer ${key}`;

    const res = await fetch(`/api/entities/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(data),
    });
    if (res.status === 401) throw new Error("Unauthorized");
    if (res.status === 409) {
      const body = await res.json();
      const err = new Error("Name conflict") as Error & { conflict: typeof body };
      err.conflict = body;
      throw err;
    }
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json() as Promise<{ updated: boolean }>;
  },

  mergeEntities: (sourceId: string, targetId: string) =>
    request<{ merged: boolean; target_id: string; aliases: string[] }>("/api/entities/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_id: sourceId, target_id: targetId }),
    }),

  entityThoughts: (id: string, cursor?: string) => {
    const search = new URLSearchParams();
    if (cursor) search.set("cursor", cursor);
    const qs = search.toString();
    return request<{ thoughts: Thought[]; next_cursor: string | null }>(
      `/api/entities/${id}/thoughts${qs ? `?${qs}` : ""}`,
    );
  },

  renamePerson: (oldName: string, newName: string) =>
    request<{ renamed: boolean; from: string; to: string; affected: number }>(
      `/api/people/${encodeURIComponent(oldName)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      },
    ),

  chat: async (
    messages: ChatMessage[],
    onChunk: (text: string) => void,
    onSources: (thoughts: SourceThought[]) => void,
  ) => {
    const key = getKey();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (key) headers["Authorization"] = `Bearer ${key}`;

    const res = await fetch("/api/chat", {
      method: "POST",
      headers,
      body: JSON.stringify({ messages }),
    });

    if (res.status === 401) throw new Error("Unauthorized");
    if (!res.ok) throw new Error(`API error: ${res.status}`);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        try {
          const parsed = JSON.parse(trimmed.slice(6));
          if (parsed.type === "chunk") onChunk(parsed.content);
          else if (parsed.type === "sources") onSources(parsed.thoughts);
        } catch {
          // skip malformed events
        }
      }
    }
  },
};

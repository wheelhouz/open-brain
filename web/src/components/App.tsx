import Router, { route } from "preact-router";
import { useState } from "preact/hooks";
import { useViewportOffset } from "../hooks/useViewportOffset";
import { AuthGate } from "./AuthGate";
import { ThemeToggle } from "./ThemeToggle";
import { ToastContainer } from "./Toast";
import { StreamView } from "../views/StreamView";
import { SearchView } from "../views/SearchView";
import { TopicsView } from "../views/TopicsView";
import { PeopleView } from "../views/PeopleView";
import { StatsView } from "../views/StatsView";
import { ChatView } from "../views/ChatView";
import { CaptureBar } from "./CaptureBar";
import { SearchBar } from "./SearchBar";
import { LoopsView } from "../views/LoopsView";
import { PersonOverlay } from "./PersonOverlay";
import { Brain, List, Hash, Users, BarChart3, MessageCircle, CircleDot } from "lucide-preact";

const tabs = [
  { path: "/", label: "Stream", icon: List, key: "1" },
  { path: "/topics", label: "Topics", icon: Hash, key: "2" },
  { path: "/people", label: "People", icon: Users, key: "3" },
  { path: "/loops", label: "Loops", icon: CircleDot, key: "4" },
  { path: "/stats", label: "Stats", icon: BarChart3, key: "5" },
  { path: "/chat", label: "Chat", icon: MessageCircle, key: "6" },
];

export function App() {
  useViewportOffset();
  const [currentPath, setCurrentPath] = useState(window.location.pathname);

  const handleRouteChange = (e: { url: string }) => {
    setCurrentPath(e.url.split("?")[0]);
  };

  const showCapture = currentPath !== "/chat";

  return (
    <AuthGate>
      <div class={`flex flex-col bg-[var(--bg-primary)] ${currentPath === "/chat" ? "chat-shell" : "min-h-screen"}`}>
        {/* Top bar */}
        <header class="sticky top-0 z-40 bg-[var(--bg-secondary)] border-b border-[var(--border-color)]">
          <div class="max-w-6xl mx-auto px-4 h-14 grid grid-cols-[auto_1fr_auto] items-center gap-4">
            <a href="/" class="flex items-center gap-2 no-underline shrink-0">
              <Brain class="w-5 h-5 text-[var(--accent)]" />
              <span class="font-semibold text-[var(--text-primary)] hidden sm:inline">
                Open Brain
              </span>
              {import.meta.env.DEV && (
                <span class="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-500">
                  dev
                </span>
              )}
            </a>
            <div class="flex justify-center">
              <SearchBar />
            </div>
            <div class="flex items-center gap-1">
              <ThemeToggle />
            </div>
          </div>
        </header>

        {/* Desktop tab navigation — hidden on mobile */}
        <nav class="hidden sm:block bg-[var(--bg-secondary)] border-b border-[var(--border-color)]">
          <div class="max-w-6xl mx-auto px-4 flex gap-1" id="tab-nav">
            {tabs.map((tab) => {
              const isActive = currentPath === tab.path;
              return (
                <a
                  key={tab.path}
                  href={tab.path}
                  onClick={(e) => {
                    e.preventDefault();
                    route(tab.path);
                  }}
                  class={`tab-link flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 transition-colors whitespace-nowrap ${
                    isActive
                      ? "text-[var(--text-primary)] border-[var(--accent)]"
                      : "text-[var(--text-secondary)] border-transparent hover:text-[var(--text-primary)] hover:border-[var(--accent)]/50"
                  }`}
                >
                  <tab.icon class="w-4 h-4" />
                  <span>{tab.label}</span>
                </a>
              );
            })}
          </div>
        </nav>

        {/* Main content — add bottom padding on mobile for bottom nav (except chat) */}
        <main class={`flex-1 min-h-0 max-w-6xl mx-auto w-full ${currentPath === "/chat" ? "flex flex-col" : "pb-16 sm:pb-0"}`}>
          <Router onChange={handleRouteChange}>
            <StreamView path="/" />
            <SearchView path="/search" />
            <TopicsView path="/topics" />
            <PeopleView path="/people" />
            <LoopsView path="/loops" />
            <StatsView path="/stats" />
            <ChatView path="/chat" />
          </Router>
        </main>

        {/* Desktop capture bar — hidden on mobile */}
        {showCapture && (
          <div class="hidden sm:block">
            <CaptureBar />
          </div>
        )}

        {/* Mobile bottom navigation */}
        <nav class="sm:hidden fixed bottom-0 left-0 right-0 z-40 bg-[var(--bg-secondary)]/80 backdrop-blur-xl border-t border-[var(--border-color)] safe-bottom">
          <div class="flex items-stretch">
            {tabs.map((tab) => {
              const isActive = currentPath === tab.path;
              return (
                <a
                  key={tab.path}
                  href={tab.path}
                  onClick={(e) => {
                    e.preventDefault();
                    route(tab.path);
                  }}
                  class={`flex-1 flex flex-col items-center justify-center py-2 min-h-[3.25rem] transition-all active:scale-90 ${
                    isActive
                      ? "text-[var(--accent)]"
                      : "text-[var(--text-muted)] active:text-[var(--text-secondary)]"
                  }`}
                >
                  <tab.icon class={`w-5 h-5 transition-transform ${isActive ? "scale-110" : ""}`} />
                  <span class={`text-[10px] mt-0.5 leading-tight transition-opacity ${isActive ? "font-medium" : ""}`}>{tab.label}</span>
                  {isActive && (
                    <span class="absolute top-0 w-8 h-0.5 rounded-full bg-[var(--accent)]" />
                  )}
                </a>
              );
            })}
          </div>
        </nav>

        {/* Mobile capture FAB — hidden on chat, hidden on desktop */}
        {showCapture && (
          <div class="sm:hidden">
            <CaptureBar mobile />
          </div>
        )}

        {/* Person overlay (global — opens from any person badge click) */}
        <PersonOverlay />

        {/* Toasts */}
        <ToastContainer />
      </div>
    </AuthGate>
  );
}

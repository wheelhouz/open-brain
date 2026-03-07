// preact-router passes `path`, `matches`, `url` as props to routed components.
// This type extends component props to accept those.
export interface RoutableProps {
  path?: string;
  url?: string;
  matches?: Record<string, string>;
}

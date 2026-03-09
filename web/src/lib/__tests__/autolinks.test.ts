import { describe, it, expect } from "vitest";
import { autoLink } from "../autolinks";

describe("autoLink", () => {
  describe("generic domains", () => {
    it("linkifies bare domain", () => {
      expect(autoLink("check out danshapiro.com for more")).toBe(
        'check out <a href="https://danshapiro.com" target="_blank" rel="noopener noreferrer">danshapiro.com</a> for more'
      );
    });

    it("linkifies subdomain", () => {
      expect(autoLink("visit factory.strongdm.ai today")).toBe(
        'visit <a href="https://factory.strongdm.ai" target="_blank" rel="noopener noreferrer">factory.strongdm.ai</a> today'
      );
    });

    it("linkifies domain with path", () => {
      expect(autoLink("see example.com/docs/guide")).toBe(
        'see <a href="https://example.com/docs/guide" target="_blank" rel="noopener noreferrer">example.com/docs/guide</a>'
      );
    });

    it("linkifies explicit http URLs", () => {
      expect(autoLink("go to https://example.com/foo")).toBe(
        'go to <a href="https://example.com/foo" target="_blank" rel="noopener noreferrer">https://example.com/foo</a>'
      );
    });

    it("does not linkify common abbreviations", () => {
      expect(autoLink("e.g. this or i.e. that")).toBe("e.g. this or i.e. that");
    });

    it("does not linkify inside markdown links", () => {
      expect(autoLink("[click here](https://example.com)")).toBe(
        "[click here](https://example.com)"
      );
    });

    it("does not linkify inside inline code", () => {
      expect(autoLink("run `curl example.com`")).toBe("run `curl example.com`");
    });

    it("does not linkify inside code blocks", () => {
      const input = "```\ncurl example.com\n```";
      expect(autoLink(input)).toBe(input);
    });

    it("handles domain at end of sentence with period", () => {
      expect(autoLink("Visit danshapiro.com.")).toBe(
        'Visit <a href="https://danshapiro.com" target="_blank" rel="noopener noreferrer">danshapiro.com</a>.'
      );
    });

    it("handles domain in parentheses", () => {
      expect(autoLink("(see danshapiro.com)")).toBe(
        '(see <a href="https://danshapiro.com" target="_blank" rel="noopener noreferrer">danshapiro.com</a>)'
      );
    });
  });
});

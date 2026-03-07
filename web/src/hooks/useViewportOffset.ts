import { useEffect } from "preact/hooks";

/**
 * Sets --viewport-offset-bottom CSS variable to compensate for Chrome iOS
 * bottom toolbar overlapping fixed-position elements.
 */
export function useViewportOffset() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    let raf = 0;

    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        document.documentElement.style.setProperty(
          "--viewport-offset-bottom",
          `${offset}px`,
        );
      });
    };

    vv.addEventListener("resize", update, { passive: true });
    vv.addEventListener("scroll", update, { passive: true });
    // Force recalc when input loses focus (keyboard close events are unreliable)
    document.addEventListener("focusout", update, { passive: true });
    update();

    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      document.removeEventListener("focusout", update);
      document.documentElement.style.setProperty("--viewport-offset-bottom", "0px");
    };
  }, []);
}

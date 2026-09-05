/* ================= SMOOTH SCROLL (additive-only) =================
   Adds inertia/easing to the native scroll via Lenis. It still moves the
   real document scroll position every frame, so window.scrollY,
   getBoundingClientRect(), and the existing `scroll` listeners in
   main.js keep working exactly as before — this file only changes how
   quickly scroll position eases toward the user's input, nothing else
   about layout, content, or the existing animations is touched. */
(function smoothScroll(){
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Lenis intercepts touch scrolling, which fights the virtual keyboard and
  // native momentum scroll on mobile (e.g. losing input focus on iOS/Android).
  // Disable it below the same 900px breakpoint the nav collapses at.
  const isMobile = matchMedia('(max-width: 900px)').matches;
  if (REDUCED || isMobile || typeof Lenis === 'undefined') return;

  const lenis = new Lenis({
    duration: 1.1,
    smoothWheel: true,
    wheelMultiplier: 1,
    touchMultiplier: 1.2,
  });

  function raf(time){
    lenis.raf(time);
    requestAnimationFrame(raf);
  }
  requestAnimationFrame(raf);
})();

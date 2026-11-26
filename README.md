# theHoreca landing page

One-page scrollytelling site built from Figma Draft 5 (file vaF03rBaeuKQSfC4hjje5O, node 26:127).
Stack: Vite 5, GSAP + ScrollTrigger, Lenis smooth scroll, three.js for the Origin globe. No framework.

    npm install
    npm run dev        # local server
    npm run build      # static site in dist/ (relative paths, host anywhere)
    npm run bake:globe # re-bake globe textures (needs Playwright + Chromium)

- `index.html`: markup. Text carries `data-i18n` keys.
- `src/i18n.js`: all EN and ID copy. EN follows better-writing; ID follows Prasaja's plain-Indonesian guide (Anda, sentence case).
- `src/main.js`: language toggle, smooth scroll, section motion, pyramid (300 ribeyes from one image), form validation.
- `src/globe.js`: clay globe (owned by the globe thread). API: `createGlobe({ canvas, overlay, labels, reduceMotion, base })` -> `{ setProgress, start, stop, resize, renderOnce }`.
- `public/img`: pencil cut-outs with backgrounds removed (rembg isnet-general-use).

Placeholders to replace before launch: `[X] working days`, `WhatsApp [number]`, the volume bands, the dashboard screen mocks (skeletons until real screens are pasted into Figma), and the form endpoint (the form has no backend yet).
Map data: world.svg from Simplemaps.com (MIT).

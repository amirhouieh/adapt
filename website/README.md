# adapt website

The public site for `@unbody-io/adapt`: an understanding layer for AI applications. Next.js + [Fumadocs](https://fumadocs.dev).

## Develop

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Layout

- `app/(home)`: landing page.
- `app/demo`: live demo.
- `app/docs`: docs (content in `content/docs`).
- `app/api/search/route.ts`: search.
- `lib/source.ts`: content source adapter.
- `lib/layout.shared.tsx`: shared layout options.
